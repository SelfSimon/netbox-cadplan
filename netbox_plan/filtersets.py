import django_filters
from django.db.models import Q
from netbox.filtersets import NetBoxModelFilterSet

from .models import Plan


class PlanFilterSet(NetBoxModelFilterSet):
    q = django_filters.CharFilter(method="search", label="Search")

    class Meta:
        model = Plan
        fields = ("id", "name", "site", "location", "selected_layer")

    def search(self, queryset, name, value):
        if not value.strip():
            return queryset
        return queryset.filter(
            Q(name__icontains=value) | Q(selected_layer__icontains=value)
        )
