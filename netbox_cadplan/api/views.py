from netbox.api.viewsets import NetBoxModelViewSet

from .. import filtersets, models
from .serializers import (
    DeviceTypeShapeSerializer,
    PlacedObjectSerializer,
    PlanSerializer,
    PlanZoneSerializer,
)


class PlanViewSet(NetBoxModelViewSet):
    queryset = models.Plan.objects.all()
    serializer_class = PlanSerializer
    filterset_class = filtersets.PlanFilterSet


class PlanZoneViewSet(NetBoxModelViewSet):
    queryset = models.PlanZone.objects.all()
    serializer_class = PlanZoneSerializer


class DeviceTypeShapeViewSet(NetBoxModelViewSet):
    queryset = models.DeviceTypeShape.objects.all()
    serializer_class = DeviceTypeShapeSerializer


class PlacedObjectViewSet(NetBoxModelViewSet):
    queryset = models.PlacedObject.objects.all()
    serializer_class = PlacedObjectSerializer
