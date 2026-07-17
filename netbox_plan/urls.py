from django.urls import include, path
from django.views.i18n import JavaScriptCatalog
from utilities.urls import get_model_urls

from . import views  # noqa: F401  (déclenche les décorateurs register_model_view)

app_name = "netbox_plan"

urlpatterns = (
    # Expose gettext()/ngettext()/interpolate() côté JS (catalogue de traduction du
    # domaine 'djangojs' de ce plugin uniquement) pour plan_editor.js — inclus comme
    # <script> avant ce dernier dans les templates qui l'utilisent.
    path(
        "jsi18n/",
        JavaScriptCatalog.as_view(packages=["netbox_plan"]),
        name="javascript-catalog",
    ),
    path("plans/", include(get_model_urls("netbox_plan", "plan", detail=False))),
    path("plans/<int:pk>/layers/", views.plan_layers, name="plan_layers"),
    path("plans/<int:pk>/locations/", views.plan_locations, name="plan_locations"),
    path(
        "plans/<int:pk>/layer-preview/",
        views.plan_layer_preview,
        name="plan_layer_preview",
    ),
    path(
        "plans/<int:pk>/confirm-layer/",
        views.plan_confirm_layer,
        name="plan_confirm_layer",
    ),
    path(
        "plans/<int:pk>/confirm-layer-preview/",
        views.plan_confirm_layer_preview,
        name="plan_confirm_layer_preview",
    ),
    path(
        "plans/<int:pk>/save-associations/",
        views.plan_save_associations,
        name="plan_save_associations",
    ),
    path(
        "plans/<int:pk>/pickable-objects/",
        views.plan_pickable_objects,
        name="plan_pickable_objects",
    ),
    path("plans/<int:pk>/export-dxf/", views.plan_export_dxf, name="plan_export_dxf"),
    path(
        "zones/<int:zone_pk>/pickable-objects/",
        views.zone_pickable_objects,
        name="zone_pickable_objects",
    ),
    path("zones/<int:zone_pk>/place/", views.place_object, name="place_object"),
    path(
        "placed-objects/<int:pk>/update/",
        views.update_placed_object,
        name="update_placed_object",
    ),
    path(
        "placed-objects/<int:pk>/remove/",
        views.remove_placed_object,
        name="remove_placed_object",
    ),
    path("plans/<int:pk>/", include(get_model_urls("netbox_plan", "plan"))),
)
