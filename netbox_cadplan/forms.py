from dcim.models import Location, Site
from django.core.exceptions import ValidationError
from django.utils.translation import gettext_lazy as _
from netbox.forms import NetBoxModelForm
from utilities.forms.fields import DynamicModelChoiceField
from utilities.forms.rendering import FieldSet, InlineFields

from .models import DeviceTypeShape, Plan

MAX_DXF_UPLOAD_SIZE = 50 * 1024 * 1024  # 50 Mo


def _validate_dxf_size(dxf_file):
    if dxf_file and dxf_file.size > MAX_DXF_UPLOAD_SIZE:
        raise ValidationError(
            _("The DXF/DWG file exceeds the maximum allowed size (50 MB).")
        )
    return dxf_file


class PlanForm(NetBoxModelForm):
    site = DynamicModelChoiceField(
        queryset=Site.objects.all(),
        required=True,
    )
    location = DynamicModelChoiceField(
        queryset=Location.objects.all(),
        required=False,
        query_params={"site_id": "$site"},
        help_text=_(
            "Optional NetBox Location (leave empty for a plan covering the whole site)"
        ),
    )

    fieldsets = (FieldSet("name", "site", "location", "dxf_file", name=_("Plan")),)

    class Meta:
        model = Plan
        fields = ("name", "site", "location", "dxf_file")

    def clean_dxf_file(self):
        return _validate_dxf_size(self.cleaned_data.get("dxf_file"))

    def clean(self):
        super().clean()
        cleaned_data = self.cleaned_data
        site = cleaned_data.get("site")
        location = cleaned_data.get("location")
        if site and location and location.site_id != site.id:
            self.add_error(
                "location",
                _("The selected location does not belong to the chosen site."),
            )
        return cleaned_data


class ReimportDxfForm(NetBoxModelForm):
    """
    Replaces only the DXF file of an already-confirmed plan (not name/site/location,
    unlike PlanForm) — clears selected_layer on save to make the layer selection
    panel reappear (see PlanReimportDxfView).
    """

    fieldsets = (FieldSet("dxf_file", name=_("Reimport a DXF")),)

    class Meta:
        model = Plan
        fields = ("dxf_file",)

    def clean_dxf_file(self):
        return _validate_dxf_size(self.cleaned_data.get("dxf_file"))

    def save(self, commit=True):
        instance = super().save(commit=False)
        instance.selected_layer = ""
        if commit:
            instance.save()
        return instance


class DeviceTypeShapeForm(NetBoxModelForm):
    fieldsets = (
        FieldSet(
            "shape",
            InlineFields("width", "depth", "diameter", "unit", label=_("Dimensions")),
            name=_("Shape"),
        ),
    )

    class Meta:
        model = DeviceTypeShape
        fields = ("shape", "width", "depth", "diameter", "unit")
