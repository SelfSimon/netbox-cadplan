from netbox.api.routers import NetBoxRouter

from . import views

app_name = "netbox_cadplan"
router = NetBoxRouter()
router.register("plans", views.PlanViewSet)
router.register("plan-zones", views.PlanZoneViewSet)
router.register("device-type-shapes", views.DeviceTypeShapeViewSet)
router.register("placed-objects", views.PlacedObjectViewSet)

urlpatterns = router.urls
