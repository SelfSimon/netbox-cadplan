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
            _("Le fichier DXF/DWG dépasse la taille maximale autorisée (50 Mo).")
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
            "Local NetBox optionnel (laisser vide pour un plan couvrant tout le site)"
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
                "location", _("Le local sélectionné n'appartient pas au site choisi.")
            )
        return cleaned_data


class ReimportDxfForm(NetBoxModelForm):
    """
    Remplace uniquement le fichier DXF d'un plan déjà confirmé (pas name/site/location,
    contrairement à PlanForm) — vide selected_layer à l'enregistrement pour faire
    réapparaître le panneau de sélection de calque (cf. PlanReimportDxfView).
    """

    fieldsets = (FieldSet("dxf_file", name=_("Réimporter un DXF")),)

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
            name=_("Forme"),
        ),
    )

    class Meta:
        model = DeviceTypeShape
        fields = ("shape", "width", "depth", "diameter", "unit")
