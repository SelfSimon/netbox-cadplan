import io
import math
import os
import re
import subprocess
import tempfile

import ezdxf
import svgwrite
from django.utils.translation import gettext as _
from ezdxf import recover


class DxfReadError(Exception):
    """Levée quand un fichier DXF/DWG ne peut pas être interprété par ezdxf."""


def _is_dwg(filepath):
    """DWG magic bytes : tous les fichiers DWG commencent par 'AC' suivi
    d'un numéro de version."""
    try:
        with open(filepath, "rb") as f:
            return f.read(2) == b"AC"
    except OSError:
        return False


def _convert_dwg_to_dxf(dwg_path):
    """
    Convertit un fichier DWG en DXF temporaire via dwg2dxf (libredwg, copié depuis
    Debian Bookworm dans l'image). Retourne le chemin du DXF temporaire — l'appelant
    DOIT le supprimer après usage. Le fichier temporaire est supprimé en cas d'erreur.
    """
    tmp = tempfile.NamedTemporaryFile(suffix=".dxf", delete=False)
    tmp.close()
    tmp_path = tmp.name
    ok = False
    try:
        result = subprocess.run(
            ["dwg2dxf", "-y", "-o", tmp_path, dwg_path],
            capture_output=True,
            timeout=60,
        )
        if result.returncode != 0:
            raise DxfReadError(
                _(
                    "Impossible de convertir le fichier DWG. "
                    "Vérifiez que le fichier n'est pas corrompu ou d'une "
                    "version trop récente."
                )
            )
        ok = True
        return tmp_path
    except FileNotFoundError as exc:
        raise DxfReadError(
            _("Le support des fichiers DWG n'est pas disponible sur ce serveur.")
        ) from exc
    finally:
        if not ok:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _read_dxf(filepath):
    if _is_dwg(filepath):
        dxf_path = _convert_dwg_to_dxf(filepath)
        try:
            return _read_dxf(dxf_path)
        finally:
            try:
                os.unlink(dxf_path)
            except OSError:
                pass
    try:
        return ezdxf.readfile(filepath)
    except ezdxf.DXFStructureError:
        try:
            doc, _auditor = recover.readfile(filepath)
        except Exception as exc:
            raise DxfReadError(
                _(
                    "Impossible de lire ce fichier. Vérifiez qu'il s'agit bien "
                    "d'un fichier DXF ou DWG valide."
                )
            ) from exc
        return doc
    except OSError as exc:
        raise DxfReadError(_("Le fichier n'a pas pu être ouvert.")) from exc


def get_dxf_layers(filepath):
    """Retourne la liste triée des noms de calques du fichier DXF."""
    doc = _read_dxf(filepath)
    return sorted(layer.dxf.name for layer in doc.layers)


def _is_effectively_closed(points):
    """
    Beaucoup de DXF réels contiennent des polylignes visuellement fermées
    (premier et dernier point quasi identiques) sans que le flag DXF "closed"
    soit positionné. On les détecte via une tolérance relative à la taille
    du polygone plutôt que de se fier uniquement au flag.
    """
    if len(points) < 3:
        return False
    (x0, y0), (x1, y1) = points[0], points[-1]
    xs = [p[0] for p in points]
    ys = [p[1] for p in points]
    diagonal = ((max(xs) - min(xs)) ** 2 + (max(ys) - min(ys)) ** 2) ** 0.5
    tolerance = max(1e-6, diagonal * 0.01)
    return ((x0 - x1) ** 2 + (y0 - y1) ** 2) ** 0.5 <= tolerance


def get_layer_polygons(filepath, layer_name):
    """
    Extrait les polygones fermés (LWPOLYLINE et POLYLINE 2D) du calque donné.
    Une polyligne est considérée fermée si son flag DXF "closed" est positionné,
    OU si son premier et dernier point coïncident (à la tolérance près) : voir
    _is_effectively_closed().
    Retourne une liste de listes de points [[x, y], ...] en unités DXF
    (non normalisées).
    """
    doc = _read_dxf(filepath)
    msp = doc.modelspace()
    polygons = []

    for entity in msp.query("LWPOLYLINE"):
        if entity.dxf.layer != layer_name:
            continue
        points = [[float(p[0]), float(p[1])] for p in entity.get_points()]
        if entity.closed or _is_effectively_closed(points):
            polygons.append(points)

    for entity in msp.query("POLYLINE"):
        if entity.dxf.layer != layer_name or not entity.is_2d_polyline:
            continue
        points = [
            [float(v.dxf.location.x), float(v.dxf.location.y)] for v in entity.vertices
        ]
        if entity.is_closed or _is_effectively_closed(points):
            polygons.append(points)

    return polygons


def polygon_fingerprint(polygon):
    """
    Aire (formule du lacet) + centroïde + nombre de sommets d'un polygone, en
    unités DXF natives (avant toute normalisation pixel). Utilisé pour
    détecter si une zone existante correspond à un nouveau polygone lors d'un
    réimport DXF (cf. match_zones_to_polygons) — pas pour un rendu
    géométrique précis, une empreinte approximative suffit.
    """
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    n = len(polygon)
    area = 0.0
    cx = 0.0
    cy = 0.0
    for i in range(n):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % n]
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area /= 2.0
    if abs(area) > 1e-9:
        cx /= 6 * area
        cy /= 6 * area
    else:
        cx = sum(xs) / n
        cy = sum(ys) / n
    return {"area": abs(area), "centroid": (cx, cy), "vertex_count": n}


def fingerprints_match(fp1, fp2, area_tolerance_ratio=0.01):
    """
    Signature volontairement basée UNIQUEMENT sur l'aire et le nombre de
    sommets — toutes deux invariantes à n'importe quelle transformation
    rigide du calque entier (translation ET rotation). Si tout le dessin
    bouge de quelques cm, voire pivote, entre deux exports, aucune pièce
    inchangée n'a sa position comparée en absolu, donc rien ne casse. Un
    local scindé en deux a chacune de ses moitiés à ~50% de l'aire d'origine
    : rejeté largement par la tolérance d'aire, donc aucune correspondance —
    exactement le comportement voulu. Un local réellement agrandi/rétréci
    (déplacement d'un mur) change aussi son aire au-delà de la tolérance :
    correctement traité comme "modifié".
    """
    if fp1["vertex_count"] != fp2["vertex_count"]:
        return False
    area_scale = max(fp1["area"], fp2["area"], 1e-9)
    return abs(fp1["area"] - fp2["area"]) / area_scale <= area_tolerance_ratio


def match_zones_to_polygons(existing_zones, new_polygons):
    """
    Apparie chaque zone existante (objet portant un attribut `source_polygon`
    — typiquement une instance PlanZone, ou None pour les zones créées avant
    ce champ, alors ignorées) aux nouveaux polygones (`new_polygons`, en
    unités DXF natives, avant normalisation) dont la signature aire+sommets
    correspond (fingerprints_match). Quand une seule pièce du bâtiment a
    cette aire, la position ne sert à rien — la translation/rotation globale
    du calque n'a donc aucune influence sur le résultat. Ce n'est que
    lorsque PLUSIEURS nouveaux polygones partagent une aire/nb de sommets
    proches de la même zone existante (ex: deux pièces de taille identique)
    que la proximité de centroïde sert de DÉPARTAGE entre ces candidats déjà
    validés par l'aire — jamais de critère de rejet en absolu. Appariement
    glouton (meilleur score d'abord), unique dans les deux sens.

    Retourne (matches, unmatched_zones, unmatched_indices) où `matches` est
    une liste de tuples (zone, index dans new_polygons), `unmatched_zones`
    les zones sans correspondance (tracé disparu ou structurellement
    changé), `unmatched_indices` les index de new_polygons sans zone
    correspondante (pièce nouvelle, ou moitié d'une pièce scindée).
    """
    new_fingerprints = [polygon_fingerprint(p) for p in new_polygons]
    candidates = []
    for zone in existing_zones:
        if not zone.source_polygon:
            continue
        zone_fp = polygon_fingerprint(zone.source_polygon)
        for index, new_fp in enumerate(new_fingerprints):
            if not fingerprints_match(zone_fp, new_fp):
                continue
            area_diff = abs(zone_fp["area"] - new_fp["area"])
            centroid_dist = math.hypot(
                zone_fp["centroid"][0] - new_fp["centroid"][0],
                zone_fp["centroid"][1] - new_fp["centroid"][1],
            )
            candidates.append((zone, index, area_diff, centroid_dist))

    # Aire la plus proche d'abord ; le centroïde ne départage qu'entre candidats déjà
    # validés par l'aire (cf. docstring) — jamais utilisé seul pour rejeter un match.
    candidates.sort(key=lambda c: (c[2], c[3]))

    matched_zone_ids = set()
    matched_indices = set()
    matches = []
    for zone, index, _area_diff, _centroid_dist in candidates:
        if zone.pk in matched_zone_ids or index in matched_indices:
            continue
        matches.append((zone, index))
        matched_zone_ids.add(zone.pk)
        matched_indices.add(index)

    unmatched_zones = [z for z in existing_zones if z.pk not in matched_zone_ids]
    unmatched_indices = [
        i for i in range(len(new_polygons)) if i not in matched_indices
    ]
    return matches, unmatched_zones, unmatched_indices


def get_layer_geometry(filepath, layer_name):
    """
    Extrait toute la géométrie filiforme (LINE, LWPOLYLINE, POLYLINE 2D, ouvertes
    ou fermées) d'un calque, à des fins de prévisualisation visuelle uniquement —
    contrairement à get_layer_polygons(), qui ne retient que les polygones fermés
    utilisés pour générer les zones. Permet de voir un calque de murs/annotations
    même s'il ne contient aucune délimitation fermée.
    Retourne une liste de {'points': [[x, y], ...], 'closed': bool}.
    """
    doc = _read_dxf(filepath)
    msp = doc.modelspace()
    strokes = []

    for entity in msp.query("LINE"):
        if entity.dxf.layer != layer_name:
            continue
        start, end = entity.dxf.start, entity.dxf.end
        strokes.append(
            {
                "points": [
                    [float(start.x), float(start.y)],
                    [float(end.x), float(end.y)],
                ],
                "closed": False,
            }
        )

    for entity in msp.query("LWPOLYLINE"):
        if entity.dxf.layer != layer_name:
            continue
        points = [[float(p[0]), float(p[1])] for p in entity.get_points()]
        strokes.append(
            {
                "points": points,
                "closed": bool(entity.closed or _is_effectively_closed(points)),
            }
        )

    for entity in msp.query("POLYLINE"):
        if entity.dxf.layer != layer_name or not entity.is_2d_polyline:
            continue
        points = [
            [float(v.dxf.location.x), float(v.dxf.location.y)] for v in entity.vertices
        ]
        strokes.append(
            {
                "points": points,
                "closed": bool(entity.is_closed or _is_effectively_closed(points)),
            }
        )

    return strokes


def _compute_scale(polygons, width_px, height_px):
    """Facteur d'échelle px par unité DXF, identique à celui utilisé par
    normalize_polygons()."""
    all_x = [p[0] for poly in polygons for p in poly]
    all_y = [p[1] for poly in polygons for p in poly]
    dxf_w = (max(all_x) - min(all_x)) or 1
    dxf_h = (max(all_y) - min(all_y)) or 1
    return min(width_px / dxf_w, height_px / dxf_h) * 0.9


def compute_mm_per_px(filepath, polygons, width_px, height_px):
    """
    Combine le facteur d'échelle px/unité-DXF (_compute_scale) avec l'unité réelle du
    fichier DXF (en-tête $INSUNITS, lu via ezdxf.units) pour obtenir mm par pixel —
    utilisé pour convertir les dimensions réelles (cm/pouces) d'un device en pixels à
    la bonne échelle visuelle par rapport à la pièce. Si le DXF ne déclare aucune unité
    ("unitless"), on suppose le millimètre (hypothèse documentée, pas de blocage UI).
    """
    if not polygons:
        return None
    scale = _compute_scale(polygons, width_px, height_px)
    doc = _read_dxf(filepath)
    if doc.units == ezdxf.units.InsertUnits.Unitless:
        mm_per_dxf_unit = 1.0
    else:
        mm_per_dxf_unit = ezdxf.units.conversion_factor(doc.units, ezdxf.units.MM)
    return mm_per_dxf_unit / scale


def compute_transform(polygons, width_px, height_px):
    """
    Paramètres de la transformation DXF (espace modèle) -> pixel canvas, identiques à
    ceux utilisés par normalize_polygons(). Centralisé ici pour que pixel_to_dxf()
    (transformation inverse, utilisée par l'export DXF) reste forcément cohérent.
    """
    all_x = [p[0] for poly in polygons for p in poly]
    all_y = [p[1] for poly in polygons for p in poly]
    min_x, max_x = min(all_x), max(all_x)
    min_y, max_y = min(all_y), max(all_y)
    dxf_w = max_x - min_x or 1
    dxf_h = max_y - min_y or 1
    scale = _compute_scale(polygons, width_px, height_px)
    return {
        "min_x": min_x,
        "min_y": min_y,
        "scale": scale,
        "offset_x": (width_px - dxf_w * scale) / 2,
        "offset_y": (height_px - dxf_h * scale) / 2,
    }


def normalize_polygons(polygons, width_px, height_px):
    """
    Normalise les coordonnées DXF (espace modèle) vers l'espace pixel du canvas.
    DXF utilise un repère Y vers le haut ; le canvas HTML un repère Y vers le bas.
    """
    if not polygons:
        return []

    t = compute_transform(polygons, width_px, height_px)

    normalized = []
    for poly in polygons:
        norm = []
        for x, y in poly:
            px = (x - t["min_x"]) * t["scale"] + t["offset_x"]
            py = height_px - ((y - t["min_y"]) * t["scale"] + t["offset_y"])
            norm.append([round(px, 2), round(py, 2)])
        normalized.append(norm)
    return normalized


def backfill_source_polygons(plan):
    """
    Renseigne source_polygon (espace DXF natif) pour les zones du plan qui
    ne l'ont pas encore — typiquement des zones créées avant l'ajout de ce
    champ. Sans cet appel, le premier réimport après l'ajout du champ
    traiterait à tort TOUTES les zones existantes comme "non appariées"
    (aucune référence DXF native à comparer), supprimant en cascade leurs
    associations et objets posés alors même que rien n'a changé dans le
    fichier.

    Doit être appelé en relisant le fichier/calque ENCORE attachés au plan, AVANT qu'un
    réimport ne les remplace (cf. PlanReimportDxfView) : on rapproche chaque zone
    existante (polygon_data, espace pixel) du polygone normalisé le plus proche issu de
    CE MÊME fichier/calque — donc de la même transformation, contrairement à
    match_zones_to_polygons() qui compare deux fichiers potentiellement différents. La
    comparaison aire+sommets utilisée par match_zones_to_polygons() reste valable ici,
    appliquée en espace pixel plutôt qu'en espace DXF natif.
    """
    if not plan.dxf_file or not plan.selected_layer:
        return
    zones = list(plan.zones.filter(source_polygon__isnull=True))
    if not zones:
        return
    try:
        polygons = get_layer_polygons(plan.dxf_file.path, plan.selected_layer)
    except DxfReadError:
        return
    if not polygons:
        return
    normalized = normalize_polygons(polygons, plan.width_px, plan.height_px)

    # Réutilise match_zones_to_polygons() en lui passant polygon_data
    # (espace pixel) à la place de source_polygon : valide ici puisque
    # `normalized` provient de la même transformation que polygon_data
    # (même fichier, même calque, rien n'a encore changé).
    class _PixelZone:
        def __init__(self, zone):
            self.pk = zone.pk
            self.source_polygon = zone.polygon_data
            self.zone = zone

    pixel_zones = [_PixelZone(z) for z in zones]
    matches, _unmatched_zones, _unmatched_indices = match_zones_to_polygons(
        pixel_zones, normalized
    )
    for pixel_zone, index in matches:
        pixel_zone.zone.source_polygon = polygons[index]
        pixel_zone.zone.save(update_fields=["source_polygon"])


def pixel_to_dxf(px, py, transform, height_px):
    """
    Transformation inverse de normalize_polygons() : reconvertit un point exprimé en
    pixel canvas (espace global du plan) vers les coordonnées du fichier DXF
    d'origine. Utilisé par l'export DXF pour replacer les objets posés sur le plan
    (PlacedObject.x/y, en pixels) à leur position réelle dans le dessin CAO.
    """
    x = (px - transform["offset_x"]) / transform["scale"] + transform["min_x"]
    y = (height_px - py - transform["offset_y"]) / transform["scale"] + transform[
        "min_y"
    ]
    return x, y


def normalize_strokes(strokes, width_px, height_px):
    """
    Comme normalize_polygons(), mais pour une liste de {'points': [...], 'closed': bool}
    pouvant contenir des tracés ouverts (issu de get_layer_geometry()).
    """
    if not strokes:
        return []
    point_lists = [s["points"] for s in strokes]
    normalized_points = normalize_polygons(point_lists, width_px, height_px)
    return [
        {"points": pts, "closed": s["closed"]}
        for s, pts in zip(strokes, normalized_points)
    ]


def extract_zone_svg(polygon_points, zone_number):
    """
    Génère un SVG individuel pour une zone (polygone + numéro), avec un padding
    autour du polygone. Retourne le contenu SVG en bytes (utf-8).
    """
    xs = [p[0] for p in polygon_points]
    ys = [p[1] for p in polygon_points]
    pad = 10
    min_x, min_y = min(xs) - pad, min(ys) - pad
    w = max(xs) - min(xs) + 2 * pad
    h = max(ys) - min(ys) + 2 * pad

    dwg = svgwrite.Drawing(size=(f"{w}px", f"{h}px"))
    shifted = [(x - min_x, y - min_y) for (x, y) in polygon_points]
    dwg.add(dwg.polygon(shifted, fill="#e8f4fd", stroke="#2196F3", stroke_width=2))

    cx = sum(xs) / len(xs) - min_x
    cy = sum(ys) / len(ys) - min_y
    dwg.add(
        dwg.text(
            str(zone_number),
            insert=(cx, cy),
            text_anchor="middle",
            font_size="14px",
            fill="#1a1a1a",
            font_weight="bold",
        )
    )

    buffer = io.StringIO()
    dwg.write(buffer)
    return buffer.getvalue().encode("utf-8")


DEVICE_EXPORT_LAYER = "NETBOX_PLAN_DEVICES"


def export_plan_dxf(filepath, selected_layer, width_px, height_px, placed_objects):
    """
    Crée un nouveau document DXF R2010 (propre, sans encodage corrompu) contenant :
    - un calque ZONES avec les polygones du plan redessinés depuis les
      données parsées
    - un calque DEVICE_EXPORT_LAYER avec les objets posés repositionnés en
      coordonnées DXF
    Cette approche évite les problèmes d'encodage/matériaux du DXF/DWG source (AC1032,
    ANSI_1252 + surrogates + données Material XML) qui empêchaient l'ouverture dans
    LibreOffice et d'autres viewers.
    `placed_objects` : liste de dicts {'x', 'y', 'rotation', 'shape', 'width_px',
    'depth_px', 'diameter_px', 'name'} (tailles en pixels canvas).
    Retourne le ezdxf.Document (à écrire via doc.write()).
    """
    polygons = get_layer_polygons(filepath, selected_layer)
    transform = compute_transform(polygons, width_px, height_px)
    scale = transform["scale"]

    doc = ezdxf.new("R2010")
    msp = doc.modelspace()

    doc.layers.add("ZONES", color=7)
    for poly in polygons:
        pts = [(p[0], p[1]) for p in poly]
        if pts:
            msp.add_lwpolyline(pts, close=True, dxfattribs={"layer": "ZONES"})

    doc.layers.add(DEVICE_EXPORT_LAYER, color=1)
    for obj in placed_objects:
        x_dxf, y_dxf = pixel_to_dxf(obj["x"], obj["y"], transform, height_px)
        name = obj.get("name")
        # Named devices become DXF blocks so FreeCAD uses the block name as
        # the object Label (visible in Properties > Data > Label).
        blk_name = re.sub(r'[<>/\\:;*?|=\'," ]', "_", name) if name else None

        if obj["shape"] == "circle":
            radius_dxf = (obj["diameter_px"] / 2) / scale
            if blk_name:
                if blk_name not in doc.blocks:
                    blk = doc.blocks.new(name=blk_name)
                    blk.add_circle(
                        (0, 0), radius_dxf, dxfattribs={"layer": DEVICE_EXPORT_LAYER}
                    )
                msp.add_blockref(
                    blk_name, (x_dxf, y_dxf), dxfattribs={"layer": DEVICE_EXPORT_LAYER}
                )
            else:
                msp.add_circle(
                    (x_dxf, y_dxf),
                    radius_dxf,
                    dxfattribs={"layer": DEVICE_EXPORT_LAYER},
                )
        else:
            hw_dxf = (obj["width_px"] / 2) / scale
            hh_dxf = (obj["depth_px"] / 2) / scale
            blk_corners = [
                (-hw_dxf, -hh_dxf),
                (hw_dxf, -hh_dxf),
                (hw_dxf, hh_dxf),
                (-hw_dxf, hh_dxf),
            ]
            if blk_name:
                if blk_name not in doc.blocks:
                    blk = doc.blocks.new(name=blk_name)
                    blk.add_lwpolyline(
                        blk_corners,
                        close=True,
                        dxfattribs={"layer": DEVICE_EXPORT_LAYER},
                    )
                msp.add_blockref(
                    blk_name,
                    (x_dxf, y_dxf),
                    dxfattribs={
                        "layer": DEVICE_EXPORT_LAYER,
                        "rotation": -(obj.get("rotation") or 0),
                    },
                )
            else:
                rad = -math.radians(obj.get("rotation") or 0)
                cos_a, sin_a = math.cos(rad), math.sin(rad)
                points = [
                    (x_dxf + lx * cos_a - ly * sin_a, y_dxf + lx * sin_a + ly * cos_a)
                    for lx, ly in blk_corners
                ]
                msp.add_lwpolyline(
                    points, close=True, dxfattribs={"layer": DEVICE_EXPORT_LAYER}
                )

    return doc
