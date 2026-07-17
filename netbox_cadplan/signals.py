from django.db.models.signals import post_delete
from django.dispatch import receiver

from .models import PlanZone


@receiver(post_delete, sender=PlanZone)
def delete_orphaned_svg_file(instance, **kwargs):
    """
    Django ne supprime jamais le fichier physique d'un FileField lors de la
    suppression de l'instance (y compris en cascade, ex: suppression d'un
    Plan qui entraîne celle de ses PlanZone). Sans ce signal, les
    SVG générés à l'association restent orphelins sur le disque.
    """
    if instance.svg_file:
        instance.svg_file.delete(save=False)
