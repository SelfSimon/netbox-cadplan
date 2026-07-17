from core.models import ObjectType
from dcim.api.serializers import (
    DeviceTypeSerializer,
    LocationSerializer,
    SiteSerializer,
)
from netbox.api.fields import ContentTypeField
from netbox.api.gfk_fields import GFKSerializerField
from netbox.api.serializers import NetBoxModelSerializer
from rest_framework import serializers

from ..models import DeviceTypeShape, PlacedObject, Plan, PlanZone


class PlanSerializer(NetBoxModelSerializer):
    url = serializers.HyperlinkedIdentityField(
        view_name="plugins-api:netbox_cadplan-api:plan-detail"
    )
    site = SiteSerializer(nested=True)
    location = LocationSerializer(nested=True, required=False, allow_null=True)

    class Meta:
        model = Plan
        fields = [
            "id",
            "url",
            "display",
            "name",
            "site",
            "location",
            "dxf_file",
            "selected_layer",
            "width_px",
            "height_px",
            "mm_per_px",
            "tags",
            "custom_fields",
            "created",
            "last_updated",
        ]
        brief_fields = ("id", "url", "display", "name")


class PlanZoneSerializer(NetBoxModelSerializer):
    url = serializers.HyperlinkedIdentityField(
        view_name="plugins-api:netbox_cadplan-api:planzone-detail"
    )
    plan = PlanSerializer(nested=True)
    location = LocationSerializer(nested=True, required=False, allow_null=True)

    class Meta:
        model = PlanZone
        fields = [
            "id",
            "url",
            "display",
            "plan",
            "number",
            "location",
            "polygon_data",
            "svg_file",
            "label",
            "tags",
            "custom_fields",
            "created",
            "last_updated",
        ]
        brief_fields = ("id", "url", "display", "number", "label")


class DeviceTypeShapeSerializer(NetBoxModelSerializer):
    url = serializers.HyperlinkedIdentityField(
        view_name="plugins-api:netbox_cadplan-api:devicetypeshape-detail"
    )
    device_type = DeviceTypeSerializer(nested=True)

    class Meta:
        model = DeviceTypeShape
        fields = [
            "id",
            "url",
            "display",
            "device_type",
            "shape",
            "width",
            "depth",
            "diameter",
            "unit",
            "tags",
            "custom_fields",
            "created",
            "last_updated",
        ]
        brief_fields = ("id", "url", "display", "device_type", "shape")


class PlacedObjectSerializer(NetBoxModelSerializer):
    url = serializers.HyperlinkedIdentityField(
        view_name="plugins-api:netbox_cadplan-api:placedobject-detail"
    )
    zone = PlanZoneSerializer(nested=True)
    object_type = ContentTypeField(queryset=ObjectType.objects.all())
    object = GFKSerializerField(source="content_object", read_only=True)

    class Meta:
        model = PlacedObject
        fields = [
            "id",
            "url",
            "display",
            "zone",
            "object_type",
            "object_id",
            "object",
            "x",
            "y",
            "rotation",
            "snap_to_wall",
            "name_position",
            "tags",
            "custom_fields",
            "created",
            "last_updated",
        ]
        brief_fields = ("id", "url", "display", "object_type", "object_id")
