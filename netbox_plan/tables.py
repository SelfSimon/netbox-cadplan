import django_tables2 as tables
from netbox.tables import NetBoxTable

from .models import Plan


class PlanTable(NetBoxTable):
    name = tables.Column(linkify=True)
    site = tables.Column(linkify=True)
    location = tables.Column(linkify=True)

    class Meta(NetBoxTable.Meta):
        model = Plan
        fields = (
            "pk",
            "id",
            "name",
            "site",
            "location",
            "selected_layer",
            "created",
            "last_updated",
        )
        default_columns = ("name", "site", "location", "selected_layer")
