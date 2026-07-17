import functools
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
    """Raised when a DXF/DWG file cannot be parsed by ezdxf."""


def _is_dwg(filepath):
    """DWG magic bytes: all DWG files start with 'AC' followed by a
    version number."""
    try:
        with open(filepath, "rb") as f:
            return f.read(2) == b"AC"
    except OSError:
        return False


def _convert_dwg_to_dxf(dwg_path):
    """
    Converts a DWG file to a temporary DXF via dwg2dxf (libredwg, copied from
    Debian Bookworm into the image). Returns the path to the temporary DXF — the
    caller MUST delete it after use. The temporary file is deleted on error.
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
                    "Unable to convert the DWG file. "
                    "Check that the file is not corrupted or in a "
                    "version that is too recent."
                )
            )
        ok = True
        return tmp_path
    except FileNotFoundError as exc:
        raise DxfReadError(
            _("DWG file support is not available on this server.")
        ) from exc
    finally:
        if not ok:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def _read_dxf_uncached(filepath):
    if _is_dwg(filepath):
        dxf_path = _convert_dwg_to_dxf(filepath)
        try:
            return _read_dxf_uncached(dxf_path)
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
                    "Unable to read this file. Check that it is a valid "
                    "DXF or DWG file."
                )
            ) from exc
        return doc
    except OSError as exc:
        raise DxfReadError(_("The file could not be opened.")) from exc


# Parsing a DXF/DWG means building a Python object for every entity in the
# drawing (potentially tens of thousands) even for a simple layer list — and
# for a DWG, converting it first via the dwg2dxf subprocess.
# get_dxf_layers/get_layer_geometry/get_layer_polygons/compute_mm_per_px are
# all read-only on the returned Document (DXF export builds its own separate
# ezdxf.new(), see export_plan_dxf), so sharing a single parsed Document across
# all these calls is safe. The (path, mtime) key automatically invalidates the
# cache as soon as a plan is reimported.
@functools.lru_cache(maxsize=8)
def _read_dxf_cached(filepath, mtime):
    return _read_dxf_uncached(filepath)


def _read_dxf(filepath):
    try:
        mtime = os.path.getmtime(filepath)
    except OSError as exc:
        raise DxfReadError(_("The file could not be opened.")) from exc
    return _read_dxf_cached(filepath, mtime)


def _layers_with_geometry(doc):
    """
    Names of layers carrying at least one wireframe entity (LINE, LWPOLYLINE,
    POLYLINE 2D) — exactly the entity types that get_layer_geometry() shows
    in the preview. Used to exclude from the list layers that contain only
    text/hatches/blocks/etc., which would otherwise systematically show
    "No elements found on this layer." once selected.
    """
    msp = doc.modelspace()
    layers = set()
    for entity in msp.query("LINE LWPOLYLINE"):
        layers.add(entity.dxf.layer)
    for entity in msp.query("POLYLINE"):
        if entity.is_2d_polyline:
            layers.add(entity.dxf.layer)
    return layers


def get_dxf_layers(filepath):
    """Returns the sorted list of layer names in the DXF file that contain at
    least one element that can be previewed (see _layers_with_geometry)."""
    doc = _read_dxf(filepath)
    usable = _layers_with_geometry(doc)
    return sorted(layer.dxf.name for layer in doc.layers if layer.dxf.name in usable)


def _is_effectively_closed(points):
    """
    Many real-world DXF files contain visually closed polylines (first and
    last point nearly identical) without the DXF "closed" flag being set.
    They are detected via a tolerance relative to the polygon's size rather
    than relying solely on the flag.
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
    Extracts the closed polygons (LWPOLYLINE and 2D POLYLINE) from the given
    layer. A polyline is considered closed if its DXF "closed" flag is set,
    OR if its first and last point coincide (within tolerance): see
    _is_effectively_closed().
    Returns a list of lists of points [[x, y], ...] in DXF units
    (not normalized).
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
    Area (shoelace formula) + centroid + vertex count of a polygon, in native
    DXF units (before any pixel normalization). Used to detect whether an
    existing zone corresponds to a new polygon during a DXF reimport (see
    match_zones_to_polygons) — not for precise geometric rendering, an
    approximate fingerprint is enough.
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
    Signature deliberately based ONLY on area and vertex count — both
    invariant to any rigid transformation of the whole layer (translation
    AND rotation). If the entire drawing shifts by a few cm, or even
    rotates, between two exports, no unchanged room has its position
    compared in absolute terms, so nothing breaks. A room split into two has
    each half at ~50% of the original area: rejected well outside the area
    tolerance, so no match — exactly the intended behavior. A room that is
    genuinely enlarged/shrunk (a wall moved) also changes its area beyond
    the tolerance: correctly treated as "modified".
    """
    if fp1["vertex_count"] != fp2["vertex_count"]:
        return False
    area_scale = max(fp1["area"], fp2["area"], 1e-9)
    return abs(fp1["area"] - fp2["area"]) / area_scale <= area_tolerance_ratio


def match_zones_to_polygons(existing_zones, new_polygons):
    """
    Matches each existing zone (object carrying a `source_polygon` attribute
    — typically a PlanZone instance, or None for zones created before this
    field existed, then ignored) to the new polygons (`new_polygons`, in
    native DXF units, before normalization) whose area+vertex signature
    matches (fingerprints_match). When only one room in the building has
    that area, position is irrelevant — the layer's global
    translation/rotation therefore has no influence on the result. Only
    when SEVERAL new polygons share a similar area/vertex count with the
    same existing zone (e.g. two rooms of identical size) does centroid
    proximity serve as a TIE-BREAKER between these candidates already
    validated by area — never used as an absolute rejection criterion.
    Greedy matching (best score first), unique in both directions.

    Returns (matches, unmatched_zones, unmatched_indices) where `matches` is
    a list of tuples (zone, index in new_polygons), `unmatched_zones` the
    zones with no match (trace disappeared or structurally changed),
    `unmatched_indices` the indices of new_polygons with no matching zone
    (new room, or half of a split room).
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

    # Closest area first; the centroid only breaks ties between candidates already
    # validated by area (see docstring) — never used alone to reject a match.
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
    Extracts all wireframe geometry (LINE, LWPOLYLINE, POLYLINE 2D, open or
    closed) from a layer, for visual preview purposes only — unlike
    get_layer_polygons(), which only keeps the closed polygons used to
    generate zones. Allows viewing a walls/annotations layer even if it
    contains no closed boundary.
    Returns a list of {'points': [[x, y], ...], 'closed': bool}.
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
    """Scale factor in px per DXF unit, identical to the one used by
    normalize_polygons()."""
    all_x = [p[0] for poly in polygons for p in poly]
    all_y = [p[1] for poly in polygons for p in poly]
    dxf_w = (max(all_x) - min(all_x)) or 1
    dxf_h = (max(all_y) - min(all_y)) or 1
    return min(width_px / dxf_w, height_px / dxf_h) * 0.9


def compute_mm_per_px(filepath, polygons, width_px, height_px):
    """
    Combines the px/DXF-unit scale factor (_compute_scale) with the DXF file's
    actual unit ($INSUNITS header, read via ezdxf.units) to obtain mm per
    pixel — used to convert a device's real dimensions (cm/inches) into
    pixels at the correct visual scale relative to the room. If the DXF
    declares no unit ("unitless"), millimeters are assumed (a documented
    assumption, not a UI blocker).
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
    Parameters of the DXF (model space) -> canvas pixel transformation,
    identical to those used by normalize_polygons(). Centralized here so
    that pixel_to_dxf() (inverse transformation, used by the DXF export)
    necessarily stays consistent.
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
    Normalizes DXF coordinates (model space) into the canvas pixel space.
    DXF uses a Y-up coordinate system; the HTML canvas uses Y-down.
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
    Fills in source_polygon (native DXF space) for the plan's zones that
    don't have it yet — typically zones created before this field was
    added. Without this call, the first reimport after adding the field
    would wrongly treat ALL existing zones as "unmatched" (no native DXF
    reference to compare against), cascading the deletion of their
    associations and placed objects even though nothing changed in the
    file.

    Must be called by re-reading the file/layer STILL attached to the plan,
    BEFORE a reimport replaces them (see PlanReimportDxfView): each existing
    zone (polygon_data, pixel space) is matched to the closest normalized
    polygon from THIS SAME file/layer — hence the same transformation,
    unlike match_zones_to_polygons() which compares two potentially
    different files. The area+vertex comparison used by
    match_zones_to_polygons() remains valid here, applied in pixel space
    rather than native DXF space.
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

    # Reuses match_zones_to_polygons() by passing it polygon_data
    # (pixel space) in place of source_polygon: valid here since
    # `normalized` comes from the same transformation as polygon_data
    # (same file, same layer, nothing has changed yet).
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
    Inverse transformation of normalize_polygons(): converts a point expressed
    in canvas pixels (the plan's global space) back to the original DXF
    file's coordinates. Used by the DXF export to place the objects on the
    plan (PlacedObject.x/y, in pixels) at their real position in the CAD
    drawing.
    """
    x = (px - transform["offset_x"]) / transform["scale"] + transform["min_x"]
    y = (height_px - py - transform["offset_y"]) / transform["scale"] + transform[
        "min_y"
    ]
    return x, y


def normalize_strokes(strokes, width_px, height_px):
    """
    Like normalize_polygons(), but for a list of {'points': [...], 'closed': bool}
    that may contain open traces (produced by get_layer_geometry()).
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
    Generates an individual SVG for a zone (polygon + number), with padding
    around the polygon. Returns the SVG content as bytes (utf-8).
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


DEVICE_EXPORT_LAYER = "NETBOX_CADPLAN_DEVICES"


def export_plan_dxf(filepath, selected_layer, width_px, height_px, placed_objects):
    """
    Creates a new, clean DXF R2010 document (no corrupted encoding) containing:
    - a ZONES layer with the plan's polygons redrawn from the parsed data
    - a DEVICE_EXPORT_LAYER layer with the placed objects repositioned in
      DXF coordinates
    This approach avoids the encoding/material issues of the source DXF/DWG
    (AC1032, ANSI_1252 + surrogates + Material XML data) that prevented it
    from opening in LibreOffice and other viewers.
    `placed_objects`: list of dicts {'x', 'y', 'rotation', 'shape', 'width_px',
    'depth_px', 'diameter_px', 'name'} (sizes in canvas pixels).
    Returns the ezdxf.Document (to be written via doc.write()).
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
