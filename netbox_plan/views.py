import io
import json

from dcim.choices import RackDimensionUnitChoices
from dcim.models import Device, DeviceType, Location, Rack, Site
from django.contrib.auth.decorators import login_required
from django.contrib.contenttypes.models import ContentType
from django.core.files.base import ContentFile
from django.http import HttpResponse, HttpResponseForbidden, JsonResponse
from django.shortcuts import get_object_or_404
from django.utils.text import slugify
from django.utils.translation import gettext as _
from django.utils.translation import gettext_lazy as _l
from django.views.decorators.http import require_GET, require_POST
from netbox.views import generic
from utilities.views import ViewTab, register_model_view

from . import filtersets, forms, tables
from .choices import LengthUnitChoices, NamePositionChoices
from .models import DeviceTypeShape, PlacedObject, Plan, PlanZone
from .utils import (
    DxfReadError,
    backfill_source_polygons,
    compute_mm_per_px,
    export_plan_dxf,
    extract_zone_svg,
    get_dxf_layers,
    get_layer_geometry,
    get_layer_polygons,
    match_zones_to_polygons,
    normalize_polygons,
    normalize_strokes,
)

_LENGTH_TO_MM = {
    LengthUnitChoices.UNIT_CENTIMETER: 10,
    LengthUnitChoices.UNIT_INCH: 25.4,
    RackDimensionUnitChoices.UNIT_MILLIMETER: 1,
    RackDimensionUnitChoices.UNIT_INCH: 25.4,
}


def _to_mm(value, unit):
    if value is None:
        return None
    return float(value) * _LENGTH_TO_MM[unit]


def _resolve_shape_mm(obj):
    """
    Retourne {'shape': 'rectangle'|'circle', 'width_mm', 'depth_mm',
    'diameter_mm'} pour un Device ou un Rack, ou None si l'objet n'a pas de
    représentation configurée (Device dont le DeviceType n'a pas de
    DeviceTypeShape, ou Rack sans outer_width/depth).
    """
    if isinstance(obj, Rack):
        if obj.outer_width is None or obj.outer_depth is None or not obj.outer_unit:
            return None
        return {
            "shape": "rectangle",
            "width_mm": _to_mm(obj.outer_width, obj.outer_unit),
            "depth_mm": _to_mm(obj.outer_depth, obj.outer_unit),
            "diameter_mm": None,
        }
    if isinstance(obj, Device):
        shape = getattr(obj.device_type, "plan_shape", None)
        if shape is None:
            return None
        if shape.shape == "circle":
            return {
                "shape": "circle",
                "width_mm": None,
                "depth_mm": None,
                "diameter_mm": _to_mm(shape.diameter, shape.unit),
            }
        return {
            "shape": "rectangle",
            "width_mm": _to_mm(shape.width, shape.unit),
            "depth_mm": _to_mm(shape.depth, shape.unit),
            "diameter_mm": None,
        }
    return None


def _serialize_pickable(obj):
    shape = _resolve_shape_mm(obj)
    content_type = ContentType.objects.get_for_model(obj)
    entry = {
        "object_type": f"{content_type.app_label}.{content_type.model}",
        "object_id": obj.pk,
        "name": str(obj),
        "url": obj.get_absolute_url(),
        "placeable": shape is not None,
    }
    entry.update(
        shape
        or {"shape": None, "width_mm": None, "depth_mm": None, "diameter_mm": None}
    )
    return entry


def _serialize_placed_object(placed):
    shape = _resolve_shape_mm(placed.content_object) or {}
    return {
        "id": placed.pk,
        "zone_number": placed.zone.number,
        "object_type": f"{placed.object_type.app_label}.{placed.object_type.model}",
        "object_id": placed.object_id,
        "name": str(placed.content_object) if placed.content_object else None,
        "url": (
            placed.content_object.get_absolute_url() if placed.content_object else None
        ),
        "x": placed.x,
        "y": placed.y,
        "rotation": placed.rotation,
        "snap_to_wall": placed.snap_to_wall,
        "outside_wall": placed.outside_wall,
        "name_position": placed.name_position,
        **shape,
    }


def _polygon_bbox(polygon):
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return min(xs), min(ys), max(xs), max(ys)


def _centroid(polygon):
    n = len(polygon)
    area = cx = cy = 0
    for i in range(n):
        x0, y0 = polygon[i]
        x1, y1 = polygon[(i + 1) % n]
        cross = x0 * y1 - x1 * y0
        area += cross
        cx += (x0 + x1) * cross
        cy += (y0 + y1) * cross
    area /= 2
    if abs(area) < 1e-9:
        return sum(p[0] for p in polygon) / n, sum(p[1] for p in polygon) / n
    return cx / (6 * area), cy / (6 * area)


def _point_in_polygon(px, py, polygon):
    inside = False
    j = len(polygon) - 1
    for i, (xi, yi) in enumerate(polygon):
        xj, yj = polygon[j]
        if ((yi > py) != (yj > py)) and (px < (xj - xi) * (py - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


@register_model_view(Plan, name="list", path="", detail=False)
class PlanListView(generic.ObjectListView):
    queryset = Plan.objects.all()
    table = tables.PlanTable
    filterset = filtersets.PlanFilterSet


def _plan_canvas_context(plan):
    zones = (
        plan.zones.select_related("location")
        .prefetch_related("placed_objects")
        .order_by("number")
    )
    return {
        "zones": zones,
        "zones_data": [
            {
                "pk": z.pk,
                "number": z.number,
                "polygon": z.polygon_data,
                "location_id": z.location_id,
                "location_name": z.location.name if z.location_id else None,
                "objects": [
                    _serialize_placed_object(po) for po in z.placed_objects.all()
                ],
            }
            for z in zones
        ],
        "mm_per_px": plan.mm_per_px,
    }


@register_model_view(Plan, name="", detail=True)
class PlanView(generic.ObjectView):
    queryset = Plan.objects.all()

    def get_extra_context(self, request, instance):
        return _plan_canvas_context(instance)


@register_model_view(Plan, name="add", detail=False)
@register_model_view(Plan, name="edit", detail=True)
class PlanEditView(generic.ObjectEditView):
    queryset = Plan.objects.all()
    form = forms.PlanForm


@register_model_view(Plan, name="delete", detail=True)
class PlanDeleteView(generic.ObjectDeleteView):
    queryset = Plan.objects.all()


@register_model_view(Plan, name="reimport_dxf", path="reimport-dxf")
class PlanReimportDxfView(generic.ObjectEditView):
    """
    Remplace le fichier DXF d'un plan déjà confirmé. ReimportDxfForm vide
    selected_layer à l'enregistrement, ce qui fait réapparaître le panneau
    de sélection de calque (plan.html : `{% if object.dxf_file and not
    object.selected_layer %}`) sans toucher aux zones existantes (`{% if
    zones %}` est indépendant de selected_layer) — c'est la confirmation du
    nouveau calque (plan_confirm_layer) qui réconcilie ensuite les zones.
    """

    queryset = Plan.objects.all()
    form = forms.ReimportDxfForm

    def post(self, request, *args, **kwargs):
        # Avant que le formulaire ne remplace dxf_file/selected_layer, comble
        # rétroactivement source_polygon sur les zones existantes qui ne
        # l'ont pas encore (créées avant l'ajout de ce champ) en relisant
        # le fichier/calque ENCORE attachés au plan à cet instant — sans
        # cette étape, le tout premier réimport traiterait à tort toutes
        # les zones existantes comme "disparues".
        plan = get_object_or_404(Plan, pk=kwargs["pk"])
        backfill_source_polygons(plan)
        return super().post(request, *args, **kwargs)


def _location_has_zone(instance):
    zone = getattr(instance, "plan_zone", None)
    return bool(zone and zone.svg_file)


@register_model_view(Location, name="zone", path="zone")
class LocationZoneView(generic.ObjectView):
    """
    Onglet "Zone" sur la page de la Location associée à une zone d'un Plan
    (PlanZone.location) : n'affiche que la zone du local courant,
    contrairement à LocationPlanView (onglet "Plan", qui affiche le plan
    complet quand cette Location est elle-même la racine d'un Plan de
    local). Une même Location peut porter les deux onglets simultanément.
    """

    queryset = Location.objects.all()
    template_name = "netbox_plan/location_tab.html"

    tab = ViewTab(
        label=_l("Zone"),
        visible=_location_has_zone,
        permission="netbox_plan.view_planzone",
    )

    def get_extra_context(self, request, instance):
        zone = getattr(instance, "plan_zone", None)
        if not zone:
            return {"zone": None, "svg_url": None}

        # Même décalage que extract_zone_svg() : recentre le polygone de la zone (espace
        # global du plan) sur une origine locale, avec un padding de 10px.
        min_x, min_y, max_x, max_y = _polygon_bbox(zone.polygon_data)
        pad = 10
        offset_x, offset_y = min_x - pad, min_y - pad

        # Polygones des zones enfants directs : utilisés pour percer des trous visuels
        # dans le rendu Konva (fillRule:'evenodd'), afin que la zone externe n'affiche
        # sa couleur de remplissage que dans son aire exclusive (hors sous-zones).
        # "Enfant direct" = zone dont le centroïde est dans cette zone ET qui n'est
        # contenu par aucune autre zone elle-même contenue dans cette zone.
        plan_zones = list(zone.plan.zones.exclude(pk=zone.pk))
        inner = [
            z
            for z in plan_zones
            if _point_in_polygon(*_centroid(z.polygon_data), zone.polygon_data)
        ]
        direct_children_polygons = [
            z.polygon_data
            for z in inner
            if not any(
                other.pk != z.pk
                and _point_in_polygon(*_centroid(z.polygon_data), other.polygon_data)
                for other in inner
            )
        ]

        return {
            "zone": zone,
            "svg_url": zone.svg_file.url if zone.svg_file else None,
            "mm_per_px": zone.plan.mm_per_px,
            "objects": [
                _serialize_placed_object(po) for po in zone.placed_objects.all()
            ],
            "polygon": zone.polygon_data,
            "inner_polygons": direct_children_polygons,
            "offset_x": offset_x,
            "offset_y": offset_y,
            "width_px": (max_x - min_x) + 2 * pad,
            "height_px": (max_y - min_y) + 2 * pad,
        }


def _site_has_plan(instance):
    return Plan.objects.filter(site=instance, location__isnull=True).exists()


def _location_has_root_plan(instance):
    return Plan.objects.filter(location=instance).exists()


@register_model_view(Site, name="plan", path="plan")
class SitePlanView(generic.ObjectView):
    """
    Onglet "Plan" sur la page du Site, visible quand ce Site a un plan couvrant tout le
    site (Plan.location = None). Affiche le plan complet (toutes les zones), avec le
    même gabarit que LocationPlanView (plan de local) — seule la requête qui résout
    `plan` change.
    """

    queryset = Site.objects.all()
    template_name = "netbox_plan/plan_tab.html"

    tab = ViewTab(
        label=_l("Plan"),
        visible=_site_has_plan,
        permission="netbox_plan.view_plan",
    )

    def get_extra_context(self, request, instance):
        plan = get_object_or_404(Plan, site=instance, location__isnull=True)
        return {"plan": plan, **_plan_canvas_context(plan)}


@register_model_view(Location, name="plan", path="plan")
class LocationPlanView(generic.ObjectView):
    """
    Onglet "Plan" sur la page de la Location, visible quand cette Location
    est elle-même la racine d'un Plan de local (Plan.location = cette
    Location). Affiche le plan complet (toutes les zones) — partage le
    même gabarit que SitePlanView.
    """

    queryset = Location.objects.all()
    template_name = "netbox_plan/plan_tab.html"

    tab = ViewTab(
        label=_l("Plan"),
        visible=_location_has_root_plan,
        permission="netbox_plan.view_plan",
    )

    def get_extra_context(self, request, instance):
        plan = get_object_or_404(Plan, location=instance)
        return {"plan": plan, **_plan_canvas_context(plan)}


@register_model_view(DeviceType, name="plan_shape_edit", path="plan-shape/edit")
class DeviceTypePlanShapeEditView(generic.ObjectEditView):
    """
    Édite (ou crée) l'unique DeviceTypeShape d'un DeviceType. Le `pk` de l'URL
    appartient au DeviceType (vue attachée via register_model_view), pas au
    DeviceTypeShape — get_object() doit donc résoudre par device_type_id, pas par pk.
    """

    queryset = DeviceTypeShape.objects.all()
    form = forms.DeviceTypeShapeForm
    template_name = "netbox_plan/devicetype_shape_edit.html"

    def get_object(self, **kwargs):
        device_type = get_object_or_404(DeviceType, pk=kwargs["pk"])
        return self.queryset.filter(device_type=device_type).first() or DeviceTypeShape(
            device_type=device_type
        )


def _candidate_locations(plan, user):
    """
    Locations exploitables pour l'association de zones de ce plan : descendants (à
    n'importe quelle profondeur) de la Location du plan si elle est définie, sinon
    toutes les Locations du site du plan (chaque Location porte un FK site direct,
    indépendamment de sa position dans l'arborescence).
    """
    if plan.location:
        return plan.location.get_descendants().restrict(user, "view")
    return Location.objects.filter(site=plan.site).restrict(user, "view")


def _location_is_valid_for_plan(location, plan):
    if plan.location:
        return location.is_descendant_of(plan.location)
    return location.site_id == plan.site_id


@login_required
@require_GET
def plan_layers(request, pk):
    """GET /plugins/plan/plans/<pk>/layers/ -> {"layers": [...]}"""
    plan = get_object_or_404(Plan, pk=pk)
    if not request.user.has_perm("netbox_plan.view_plan"):
        return HttpResponseForbidden()
    if not plan.dxf_file:
        return JsonResponse(
            {"error": _("Aucun fichier DXF n'est associé à ce plan.")}, status=400
        )
    try:
        layers = get_dxf_layers(plan.dxf_file.path)
    except DxfReadError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    return JsonResponse({"layers": layers})


@login_required
@require_GET
def plan_layer_preview(request, pk):
    """
    GET /plugins/plan/plans/<pk>/layer-preview/?layer=<name>
    Aperçu en lecture seule de toute la géométrie filiforme d'un calque
    (murs, annotations, délimitations ouvertes ou fermées — normalisée en
    pixels canvas), sans rien persister. Volontairement plus permissif que
    get_layer_polygons() (utilisé par confirm-layer) : on veut voir le calque
    même s'il ne contient aucune délimitation fermée, pour pouvoir comparer
    plusieurs calques avant de choisir le bon.
    """
    plan = get_object_or_404(Plan, pk=pk)
    if not request.user.has_perm("netbox_plan.view_plan"):
        return HttpResponseForbidden()
    if not plan.dxf_file:
        return JsonResponse(
            {"error": _("Aucun fichier DXF n'est associé à ce plan.")}, status=400
        )
    layer_name = (request.GET.get("layer") or "").strip()
    if not layer_name:
        return JsonResponse({"error": _("Le paramètre layer est requis.")}, status=400)
    try:
        strokes = get_layer_geometry(plan.dxf_file.path, layer_name)
    except DxfReadError as exc:
        return JsonResponse({"error": str(exc)}, status=400)
    normalized = normalize_strokes(strokes, plan.width_px, plan.height_px)
    return JsonResponse({"strokes": normalized})


def _location_display(location, root):
    """Chemin hiérarchique de `location` relatif à `root`
    (ex: 'Local 114 / Local 114.1')."""
    chain = []
    node = location
    while node and node.pk != root.pk:
        chain.append(node.name)
        node = node.parent
    return " / ".join(reversed(chain))


@login_required
@require_GET
def plan_locations(request, pk):
    """
    GET /plugins/plan/plans/<pk>/locations/
    Si le plan a une Location racine : tous ses descendants (à n'importe quelle
    profondeur), pour peupler le menu d'association. Sinon (plan couvrant tout un
    site) : toutes les Locations de ce site. L'API NetBox /api/dcim/locations/ ne
    filtre que par parent direct (parent_id) ; les Locations imbriquées (ex: Local 114
    -> Local 114.1) nécessitent une vraie requête d'arborescence MPTT.
    """
    plan = get_object_or_404(Plan, pk=pk)
    if not request.user.has_perm("netbox_plan.view_plan"):
        return HttpResponseForbidden()

    candidates = _candidate_locations(plan, request.user)
    if plan.location:
        locations = [
            {"id": loc.pk, "name": _location_display(loc, plan.location)}
            for loc in candidates
        ]
    else:
        locations = [{"id": loc.pk, "name": loc.name} for loc in candidates]
    locations.sort(key=lambda item: item["name"])
    return JsonResponse({"locations": locations})


def _layer_name_and_polygons_from_request(plan, request):
    """
    Factorise la validation commune à
    plan_confirm_layer()/plan_confirm_layer_preview() : fichier DXF
    présent, corps JSON valide, layer_name fourni, calque lisible et non
    vide. Retourne (layer_name, polygons, None) ou (None, None,
    JsonResponse d'erreur).
    """
    if not plan.dxf_file:
        return (
            None,
            None,
            JsonResponse(
                {"error": _("Aucun fichier DXF n'est associé à ce plan.")}, status=400
            ),
        )
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return (
            None,
            None,
            JsonResponse({"error": _("Corps de requête JSON invalide.")}, status=400),
        )
    layer_name = (data.get("layer_name") or "").strip()
    if not layer_name:
        return (
            None,
            None,
            JsonResponse({"error": _("layer_name est requis.")}, status=400),
        )

    try:
        polygons = get_layer_polygons(plan.dxf_file.path, layer_name)
    except DxfReadError as exc:
        return None, None, JsonResponse({"error": str(exc)}, status=400)

    if not polygons:
        return (
            None,
            None,
            JsonResponse(
                {
                    "error": _(
                        "Aucune délimitation fermée trouvée sur le calque "
                        "« %(layer_name)s »."
                    )
                    % {"layer_name": layer_name}
                },
                status=400,
            ),
        )
    return layer_name, polygons, None


@login_required
@require_POST
def plan_confirm_layer_preview(request, pk):
    """
    POST /plugins/plan/plans/<pk>/confirm-layer-preview/
    body: {"layer_name": "..."}
    Calcule (sans rien écrire en base) le résumé de ce que produirait
    plan_confirm_layer() sur ce calque : nombre de zones inchangées /
    supprimées / créées, et d'objets posés qui seraient retirés. Permet
    d'afficher un récapitulatif avant application lors d'un réimport (cf.
    plan_confirm_layer, même algorithme de réconciliation).
    """
    plan = get_object_or_404(Plan, pk=pk)
    if not request.user.has_perm("netbox_plan.change_plan"):
        return HttpResponseForbidden()

    layer_name, polygons, error = _layer_name_and_polygons_from_request(plan, request)
    if error:
        return error

    existing_zones = list(plan.zones.all())
    matches, unmatched_zones, unmatched_indices = match_zones_to_polygons(
        existing_zones, polygons
    )
    placed_objects_removed = sum(
        zone.placed_objects.count() for zone in unmatched_zones
    )

    return JsonResponse(
        {
            "summary": {
                "unchanged": len(matches),
                "removed": len(unmatched_zones),
                "created": len(unmatched_indices),
                "placed_objects_removed": placed_objects_removed,
            }
        }
    )


@login_required
@require_POST
def plan_confirm_layer(request, pk):
    """
    POST /plugins/plan/plans/<pk>/confirm-layer/  body: {"layer_name": "..."}
    Fixe le calque sélectionné et réconcilie les PlanZone avec les
    polygones fermés de ce calque (normalisés en pixels canvas) : une zone
    existante dont le tracé DXF natif (source_polygon) correspond toujours
    à un nouveau polygone (cf. match_zones_to_polygons) est conservée
    telle quelle (numéro, association, objets posés, tags) ; une zone sans
    correspondance (tracé disparu ou structurellement changé, ex: local
    scindé) est supprimée (cascade : ses objets posés aussi) ; un nouveau
    polygone sans zone correspondante devient une zone fraîche, non
    associée. Fonctionne aussi bien pour le tout premier import (aucune
    zone existante => tout est "nouveau", comportement historique) que
    pour un réimport.
    """
    plan = get_object_or_404(Plan, pk=pk)
    if not request.user.has_perm("netbox_plan.change_plan"):
        return HttpResponseForbidden()

    layer_name, polygons, error = _layer_name_and_polygons_from_request(plan, request)
    if error:
        return error

    normalized = normalize_polygons(polygons, plan.width_px, plan.height_px)

    plan.selected_layer = layer_name
    plan.mm_per_px = compute_mm_per_px(
        plan.dxf_file.path, polygons, plan.width_px, plan.height_px
    )
    plan.save()

    existing_zones = list(plan.zones.all())
    matches, unmatched_zones, unmatched_indices = match_zones_to_polygons(
        existing_zones, polygons
    )

    placed_objects_removed = sum(
        zone.placed_objects.count() for zone in unmatched_zones
    )
    for zone in unmatched_zones:
        zone.delete()

    for zone, index in matches:
        zone.polygon_data = normalized[index]
        zone.source_polygon = polygons[index]
        zone.save()

    next_number = max((z.number for z in existing_zones), default=0) + 1
    for index in unmatched_indices:
        PlanZone.objects.create(
            plan=plan,
            number=next_number,
            polygon_data=normalized[index],
            source_polygon=polygons[index],
        )
        next_number += 1

    # Renumérotation compacte : supprime les trous et la dérive vers le
    # haut qui apparaît quand toutes les zones sont non appariées (zones
    # sans source_polygon, premier réimport après la migration). Ordre
    # croissant = jamais de conflit UniqueConstraint car les trous sont
    # dans les valeurs basses (libérées par les zones supprimées).
    zones = []
    for new_number, zone in enumerate(plan.zones.order_by("number"), start=1):
        if zone.number != new_number:
            zone.number = new_number
            zone.save(update_fields=["number"])
        zones.append({"number": zone.number, "polygon": zone.polygon_data})

    return JsonResponse(
        {
            "status": "ok",
            "selected_layer": layer_name,
            "zones": zones,
            "summary": {
                "unchanged": len(matches),
                "removed": len(unmatched_zones),
                "created": len(unmatched_indices),
                "placed_objects_removed": placed_objects_removed,
            },
        }
    )


@login_required
@require_POST
def plan_save_associations(request, pk):
    """
    POST /plugins/plan/plans/<pk>/save-associations/
    body: {"associations": [{"zone_number": 1, "location_id": 5}, ...]}
    Un location_id null/absent désassocie la zone.
    """
    plan = get_object_or_404(Plan, pk=pk)
    if not request.user.has_perm("netbox_plan.change_planzone"):
        return HttpResponseForbidden()
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": _("Corps de requête JSON invalide.")}, status=400)

    associations = data.get("associations") or []
    zones_by_number = {z.number: z for z in plan.zones.all()}
    saved = 0
    errors = []

    for assoc in associations:
        try:
            zone_number = int(assoc["zone_number"])
        except (KeyError, TypeError, ValueError):
            errors.append(_("Entrée invalide (zone_number manquant)."))
            continue
        zone = zones_by_number.get(zone_number)
        if zone is None:
            errors.append(
                _("Zone %(zone_number)s introuvable pour ce plan.")
                % {"zone_number": zone_number}
            )
            continue

        location_id = assoc.get("location_id")
        if location_id in (None, ""):
            zone.location = None
            zone.svg_file.delete(save=False)
            # Une fois la zone déliée, les devices/racks qui y étaient
            # posés n'ont plus de local valide où rester ancrés (leur
            # Location NetBox propre reste inchangée, mais la zone
            # elle-même ne représente plus aucun local) : on les retire
            # du plan pour qu'ils redeviennent plaçables ailleurs, plutôt
            # que de les laisser flotter dans une zone redevenue un
            # simple numéro.
            zone.placed_objects.all().delete()
        else:
            try:
                location = Location.objects.get(pk=location_id)
            except (Location.DoesNotExist, ValueError, TypeError):
                errors.append(
                    _("Location %(location_id)s invalide pour la zone %(zone_number)s.")
                    % {"location_id": location_id, "zone_number": zone_number}
                )
                continue
            if not _location_is_valid_for_plan(location, plan):
                errors.append(
                    _("Location %(location_id)s invalide pour la zone %(zone_number)s.")
                    % {"location_id": location_id, "zone_number": zone_number}
                )
                continue
            other = (
                PlanZone.objects.filter(location=location).exclude(pk=zone.pk).first()
            )
            if other:
                errors.append(
                    _(
                        "Location %(location_id)s déjà associée à la zone "
                        "%(other_number)s."
                    )
                    % {"location_id": location_id, "other_number": other.number}
                )
                continue
            zone.location = location
            svg_bytes = extract_zone_svg(zone.polygon_data, zone.number)
            zone.svg_file.save(
                f"zone_{zone.pk}.svg", ContentFile(svg_bytes), save=False
            )
        zone.save()
        saved += 1

    return JsonResponse({"status": "ok", "saved": saved, "errors": errors})


def _pickable_objects_for_locations(locations):
    """Racks + Devices non rackés des `locations` données, non encore
    placés sur un plan."""
    placed_keys = set(
        PlacedObject.objects.values_list(
            "object_type__app_label", "object_type__model", "object_id"
        )
    )

    def _not_placed(obj, app_label, model):
        return (app_label, model, obj.pk) not in placed_keys

    racks = [
        _serialize_pickable(r)
        for r in Rack.objects.filter(location__in=locations)
        if _not_placed(r, "dcim", "rack")
    ]
    devices = [
        _serialize_pickable(d)
        for d in Device.objects.filter(location__in=locations, rack__isnull=True)
        if _not_placed(d, "dcim", "device")
    ]
    return racks, devices


@login_required
@require_GET
def zone_pickable_objects(request, zone_pk):
    """
    GET /plugins/plan/zones/<zone_pk>/pickable-objects/
    Racks/Devices non rackés du local associé à cette zone, non encore placés.
    """
    zone = get_object_or_404(PlanZone, pk=zone_pk)
    if not request.user.has_perm("netbox_plan.view_planzone"):
        return HttpResponseForbidden()
    if not zone.location:
        return JsonResponse({"racks": [], "devices": []})
    racks, devices = _pickable_objects_for_locations([zone.location])
    return JsonResponse({"racks": racks, "devices": devices})


@login_required
@require_GET
def plan_pickable_objects(request, pk):
    """
    GET /plugins/plan/plans/<pk>/pickable-objects/
    Racks/Devices non rackés de tous les locaux candidats du plan (descendants de sa
    Location racine, ou tous les locaux du site si le plan n'a pas de Location), non
    encore placés. Chaque entrée porte le numéro de la zone où elle doit être déposée
    (dérivée de location.plan_zone) ; les locaux sans zone associée ne sont pas inclus
    (aucun polygone où ancrer le placement).
    """
    plan = get_object_or_404(Plan, pk=pk)
    if not request.user.has_perm("netbox_plan.view_plan"):
        return HttpResponseForbidden()

    locations = list(_candidate_locations(plan, request.user))
    zone_by_location = {
        z.location_id: z.number for z in plan.zones.exclude(location=None)
    }
    locations = [loc for loc in locations if loc.pk in zone_by_location]

    racks, devices = _pickable_objects_for_locations(locations)
    for entry in racks + devices:
        model = Rack if entry["object_type"] == "dcim.rack" else Device
        obj_location_id = model.objects.values_list("location_id", flat=True).get(
            pk=entry["object_id"]
        )
        entry["zone_number"] = zone_by_location.get(obj_location_id)

    return JsonResponse({"racks": racks, "devices": devices})


@login_required
@require_GET
def plan_export_dxf(request, pk):
    """
    GET /plugins/plan/plans/<pk>/export-dxf/
    Télécharge le DXF d'origine du plan, complété d'un nouveau calque
    (utils.DEVICE_EXPORT_LAYER) contenant les Devices/Racks posés sur le plan, à leur
    position réelle (transformation inverse de celle utilisée à l'import).
    """
    plan = get_object_or_404(Plan, pk=pk)
    if not request.user.has_perm("netbox_plan.view_plan"):
        return HttpResponseForbidden()
    if not plan.dxf_file or not plan.selected_layer:
        return JsonResponse(
            {
                "error": _(
                    "Ce plan n'a pas de fichier DXF avec un calque de "
                    "zones sélectionné."
                )
            },
            status=400,
        )

    mm_per_px = plan.mm_per_px or 1
    entries = []
    placed_objects = PlacedObject.objects.filter(zone__plan=plan).select_related("zone")
    for placed in placed_objects:
        shape = _resolve_shape_mm(placed.content_object)
        if shape is None:
            continue
        entries.append(
            {
                "x": placed.x,
                "y": placed.y,
                "rotation": placed.rotation,
                "shape": shape["shape"],
                "width_px": (
                    (shape["width_mm"] / mm_per_px)
                    if shape["width_mm"] is not None
                    else None
                ),
                "depth_px": (
                    (shape["depth_mm"] / mm_per_px)
                    if shape["depth_mm"] is not None
                    else None
                ),
                "diameter_px": (
                    (shape["diameter_mm"] / mm_per_px)
                    if shape["diameter_mm"] is not None
                    else None
                ),
                "name": str(placed.content_object),
            }
        )

    try:
        doc = export_plan_dxf(
            plan.dxf_file.path,
            plan.selected_layer,
            plan.width_px,
            plan.height_px,
            entries,
        )
    except DxfReadError as exc:
        return JsonResponse({"error": str(exc)}, status=400)

    buffer = io.StringIO()
    doc.write(buffer)
    filename = f"{slugify(plan.name) or 'plan'}_devices.dxf"
    response = HttpResponse(
        buffer.getvalue().encode("utf-8"), content_type="application/dxf"
    )
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    return response


@login_required
@require_POST
def place_object(request, zone_pk):
    """
    POST /plugins/plan/zones/<zone_pk>/place/
    body: {"object_type": "dcim.device", "object_id": 5}
    Crée le PlacedObject au centre de la bounding box du polygone de la zone.
    """
    zone = get_object_or_404(PlanZone, pk=zone_pk)
    if not request.user.has_perm("netbox_plan.add_placedobject"):
        return HttpResponseForbidden()
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": _("Corps de requête JSON invalide.")}, status=400)

    object_type_label = (data.get("object_type") or "").strip()
    object_id = data.get("object_id")
    try:
        app_label, model_name = object_type_label.split(".")
        content_type = ContentType.objects.get(app_label=app_label, model=model_name)
    except (ValueError, ContentType.DoesNotExist):
        return JsonResponse(
            {
                "error": _(
                    "object_type invalide (attendu 'dcim.device' ou 'dcim.rack')."
                )
            },
            status=400,
        )
    if model_name not in ("device", "rack"):
        return JsonResponse(
            {"error": _("Seuls les devices et les racks peuvent être placés.")},
            status=400,
        )

    obj = get_object_or_404(content_type.model_class(), pk=object_id)
    if obj.location_id != zone.location_id:
        return JsonResponse(
            {"error": _("Cet objet n'appartient pas au local associé à cette zone.")},
            status=400,
        )
    if _resolve_shape_mm(obj) is None:
        return JsonResponse(
            {
                "error": _(
                    "Aucune forme configurée pour cet objet (DeviceType "
                    "sans Plan, ou Rack sans dimensions outer)."
                )
            },
            status=400,
        )
    if PlacedObject.objects.filter(object_type=content_type, object_id=obj.pk).exists():
        return JsonResponse(
            {"error": _("Cet objet est déjà placé sur un plan.")}, status=400
        )

    min_x, min_y, max_x, max_y = _polygon_bbox(zone.polygon_data)
    placed = PlacedObject.objects.create(
        zone=zone,
        object_type=content_type,
        object_id=obj.pk,
        x=(min_x + max_x) / 2,
        y=(min_y + max_y) / 2,
    )
    return JsonResponse({"status": "ok", "object": _serialize_placed_object(placed)})


@login_required
@require_POST
def update_placed_object(request, pk):
    """
    POST /plugins/plan/placed-objects/<pk>/update/
    body: {"x": .., "y": .., "rotation": .., "snap_to_wall": ..,
    "outside_wall": .., "name_position": ..}
    L'aimantation au mur (intérieure ou extérieure) est calculée côté JS ;
    ce point ne fait que persister le résultat final (x/y/rotation déjà
    ajustés par le client si besoin).
    """
    placed = get_object_or_404(PlacedObject, pk=pk)
    if not request.user.has_perm("netbox_plan.change_placedobject"):
        return HttpResponseForbidden()
    try:
        data = json.loads(request.body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return JsonResponse({"error": _("Corps de requête JSON invalide.")}, status=400)

    for field in ("x", "y", "rotation"):
        if field in data:
            try:
                setattr(placed, field, float(data[field]))
            except (TypeError, ValueError):
                return JsonResponse(
                    {"error": _("%(field)s doit être numérique.") % {"field": field}},
                    status=400,
                )
    if "snap_to_wall" in data:
        placed.snap_to_wall = bool(data["snap_to_wall"])
    if "outside_wall" in data:
        placed.outside_wall = bool(data["outside_wall"])
    if placed.outside_wall:
        # Mutuellement exclusif : l'aimantation intérieure n'a pas de sens pour un objet
        # collé en permanence à l'extérieur du polygone.
        placed.snap_to_wall = False
    if "name_position" in data:
        name_position = data["name_position"]
        if name_position not in dict(NamePositionChoices.CHOICES):
            return JsonResponse({"error": _("name_position invalide.")}, status=400)
        placed.name_position = name_position

    placed.full_clean()
    placed.save()
    return JsonResponse({"status": "ok", "object": _serialize_placed_object(placed)})


@login_required
@require_POST
def remove_placed_object(request, pk):
    """POST /plugins/plan/placed-objects/<pk>/remove/ : retire l'objet du plan."""
    placed = get_object_or_404(PlacedObject, pk=pk)
    if not request.user.has_perm("netbox_plan.delete_placedobject"):
        return HttpResponseForbidden()
    placed.delete()
    return JsonResponse({"status": "ok"})
