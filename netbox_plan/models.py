from django.contrib.contenttypes.fields import GenericForeignKey
from django.contrib.contenttypes.models import ContentType
from django.core.exceptions import ValidationError
from django.db import models
from django.db.models import Q
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from netbox.models import NetBoxModel

from .choices import LengthUnitChoices, NamePositionChoices, ShapeChoices


class Plan(NetBoxModel):
    name = models.CharField(_("nom"), max_length=100)
    site = models.ForeignKey(
        verbose_name=_("site"),
        to="dcim.Site",
        on_delete=models.PROTECT,
        related_name="plans",
    )
    location = models.ForeignKey(
        verbose_name=_("local"),
        to="dcim.Location",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="plans",
    )
    dxf_file = models.FileField(_("fichier DXF"), upload_to="plans/dxf/")
    selected_layer = models.CharField(
        _("calque sélectionné"), max_length=200, blank=True
    )
    width_px = models.PositiveIntegerField(default=1200)
    height_px = models.PositiveIntegerField(default=800)
    # Échelle réelle du plan (millimètres représentés par un pixel canvas), calculée à
    # partir de l'unité DXF détectée ($INSUNITS) lors de la génération des zones.
    # Permet de convertir les dimensions réelles (cm/pouces) d'un DeviceTypeShape/Rack
    # en pixels à la bonne échelle visuelle. Null si aucun calque n'a encore
    # été confirmé.
    mm_per_px = models.FloatField(null=True, blank=True)

    class Meta:
        ordering = ["name"]
        constraints = [
            models.UniqueConstraint(
                fields=["site", "location"], name="unique_plan_site_location"
            ),
        ]

    def __str__(self):
        return self.name

    def get_absolute_url(self):
        return reverse("plugins:netbox_plan:plan", args=[self.pk])

    def clean(self):
        super().clean()
        if not self.site_id:
            return
        if self.location_id:
            if self.location.site_id != self.site_id:
                raise ValidationError(
                    {
                        "location": _(
                            "Le local sélectionné n'appartient pas au site choisi."
                        )
                    }
                )
            # Mutuelle exclusivité : pas de plan de local si un plan de site
            # entier existe déjà.
            if (
                Plan.objects.filter(site_id=self.site_id, location__isnull=True)
                .exclude(pk=self.pk)
                .exists()
            ):
                raise ValidationError(
                    {
                        "location": _(
                            "Un plan couvrant tout le site existe déjà pour ce site ; "
                            "impossible de créer un plan de local."
                        )
                    }
                )
        else:
            # UniqueConstraint(site, location) ne bloque pas deux lignes
            # location=NULL pour le même site (NULL != NULL en SQL) : on
            # l'impose donc explicitement ici.
            if (
                Plan.objects.filter(site_id=self.site_id, location__isnull=True)
                .exclude(pk=self.pk)
                .exists()
            ):
                raise ValidationError(
                    {
                        "site": _(
                            "Un plan sans local (couvrant tout le site) existe "
                            "déjà pour ce site."
                        )
                    }
                )
            # Mutuelle exclusivité : pas de plan de site entier si des plans
            # de local existent déjà.
            if (
                Plan.objects.filter(site_id=self.site_id, location__isnull=False)
                .exclude(pk=self.pk)
                .exists()
            ):
                raise ValidationError(
                    {
                        "site": _(
                            "Des plans de local existent déjà pour ce site ; "
                            "impossible de créer un plan couvrant tout le site."
                        )
                    }
                )


class PlanZone(NetBoxModel):
    plan = models.ForeignKey(
        to=Plan,
        on_delete=models.CASCADE,
        related_name="zones",
    )
    number = models.PositiveIntegerField()
    # OneToOne : un local (Location) ne peut correspondre qu'à une seule zone du plan.
    location = models.OneToOneField(
        to="dcim.Location",
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name="plan_zone",
    )
    polygon_data = models.JSONField()
    # Polygone brut en unités DXF natives (avant normalize_polygons), distinct de
    # polygon_data (espace pixel, utilisé pour le rendu). Sert de référence stable pour
    # détecter si cette zone a réellement changé lors d'un réimport du DXF — comparer
    # polygon_data directement serait piégé par un simple décalage/rescale global de
    # toutes les zones du calque (cf. compute_transform()), sans rapport avec un vrai
    # changement de cette pièce. Null pour les zones créées avant ce champ.
    source_polygon = models.JSONField(null=True, blank=True)
    svg_file = models.FileField(upload_to="plans/svg/", null=True, blank=True)
    label = models.CharField(max_length=100, blank=True)

    class Meta:
        ordering = ["plan", "number"]
        constraints = [
            models.UniqueConstraint(
                fields=["plan", "number"], name="unique_plan_zone_number"
            ),
        ]

    def __str__(self):
        if self.location:
            return f"Zone {self.number} ({self.location}) – {self.plan}"
        return f"Zone {self.number} – {self.plan}"

    def get_absolute_url(self):
        return reverse("plugins:netbox_plan:plan", args=[self.plan_id])


class DeviceTypeShape(NetBoxModel):
    """
    Représentation graphique (forme + dimensions réelles) d'un DeviceType sur un plan.
    Un Rack n'a pas besoin de ce modèle : ses dimensions viennent directement
    de dcim.Rack (outer_width/outer_depth/outer_unit).
    """

    device_type = models.OneToOneField(
        to="dcim.DeviceType",
        on_delete=models.CASCADE,
        related_name="plan_shape",
    )
    shape = models.CharField(
        max_length=20, choices=ShapeChoices, default=ShapeChoices.RECTANGLE
    )
    width = models.DecimalField(
        _("largeur"), max_digits=8, decimal_places=2, null=True, blank=True
    )
    depth = models.DecimalField(
        _("profondeur"), max_digits=8, decimal_places=2, null=True, blank=True
    )
    diameter = models.DecimalField(
        _("diamètre"), max_digits=8, decimal_places=2, null=True, blank=True
    )
    unit = models.CharField(
        _("unité"),
        max_length=10,
        choices=LengthUnitChoices,
        default=LengthUnitChoices.UNIT_CENTIMETER,
    )

    class Meta:
        ordering = ["device_type"]

    def __str__(self):
        return f"Forme de {self.device_type}"

    def get_absolute_url(self):
        return self.device_type.get_absolute_url()

    def clean(self):
        super().clean()
        if self.shape == ShapeChoices.RECTANGLE:
            if self.width is None or self.depth is None:
                raise ValidationError(
                    _("La largeur et la profondeur sont requises pour un rectangle.")
                )
        elif self.shape == ShapeChoices.CIRCLE:
            if self.diameter is None:
                raise ValidationError(_("Le diamètre est requis pour un cercle."))


class PlacedObject(NetBoxModel):
    """
    Positionnement d'un Device ou d'un Rack NetBox sur un plan. `x`/`y` sont
    exprimés dans le même espace pixel global que PlanZone.polygon_data (voir
    normalize_polygons()) : la vue du plan les affiche tels quels, la vue d'un local
    applique le même décalage que extract_zone_svg() pour les recentrer sur la zone.
    Une seule ligne en base pour les deux vues : la synchronisation est automatique.
    """

    zone = models.ForeignKey(
        to=PlanZone,
        on_delete=models.CASCADE,
        related_name="placed_objects",
    )
    object_type = models.ForeignKey(
        to=ContentType,
        on_delete=models.CASCADE,
        limit_choices_to=Q(app_label="dcim", model__in=("device", "rack")),
    )
    object_id = models.PositiveBigIntegerField()
    content_object = GenericForeignKey("object_type", "object_id")
    x = models.FloatField()
    y = models.FloatField()
    # Degrés ; pertinent pour les rectangles uniquement (ignoré pour les cercles).
    rotation = models.FloatField(default=0)
    snap_to_wall = models.BooleanField(default=False)
    # Quand True : l'objet est posé à l'extérieur du polygone de la zone, collé en
    # permanence contre le mur le plus proche (glisse le long du périmètre lors du
    # déplacement, ne peut pas s'en détacher) — mutuellement exclusif avec
    # snap_to_wall, qui ne concerne que l'aimantation optionnelle à l'intérieur.
    outside_wall = models.BooleanField(default=False)
    name_position = models.CharField(
        max_length=10,
        choices=NamePositionChoices,
        default=NamePositionChoices.CENTER,
    )

    class Meta:
        ordering = ["zone", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["object_type", "object_id"],
                name="unique_placed_object_per_target",
            ),
        ]

    def __str__(self):
        return f"{self.content_object} @ {self.zone}"

    def get_absolute_url(self):
        return reverse("plugins:netbox_plan:plan", args=[self.zone.plan_id])
