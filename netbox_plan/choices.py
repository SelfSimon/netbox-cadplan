from django.utils.translation import gettext_lazy as _
from utilities.choices import ChoiceSet


class ShapeChoices(ChoiceSet):

    RECTANGLE = "rectangle"
    CIRCLE = "circle"

    CHOICES = (
        (RECTANGLE, _("Rectangle")),
        (CIRCLE, _("Cercle")),
    )


class LengthUnitChoices(ChoiceSet):

    UNIT_CENTIMETER = "cm"
    UNIT_INCH = "in"

    CHOICES = (
        (UNIT_CENTIMETER, _("Centimètres")),
        (UNIT_INCH, _("Pouces")),
    )


class NamePositionChoices(ChoiceSet):

    TOP = "top"
    BOTTOM = "bottom"
    LEFT = "left"
    RIGHT = "right"
    CENTER = "center"

    CHOICES = (
        (TOP, _("En haut")),
        (BOTTOM, _("En bas")),
        (LEFT, _("À gauche")),
        (RIGHT, _("À droite")),
        (CENTER, _("Au centre")),
    )
