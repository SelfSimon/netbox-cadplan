(function () {
  const COLORS = {
    default: { stroke: '#2196F3', fill: 'rgba(33,150,243,0.15)' },
    associated: { stroke: '#43a047', fill: 'rgba(67,160,71,0.18)' },
    selected: { stroke: '#f59f00', fill: 'rgba(245,159,0,0.20)' },
  };

  function getCsrfToken() {
    // CSRF_COOKIE_HTTPONLY=True dans NetBox : le cookie csrftoken n'est pas lisible en JS.
    // NetBox expose le token via window.CSRF_TOKEN (voir templates/base/base.html).
    return window.CSRF_TOKEN;
  }

  // Le plan est normalisé côté serveur dans un espace logique dataWidth x dataHeight
  // (Plan.width_px / height_px), mais la carte Bootstrap qui contient le canvas
  // peut être bien plus étroite selon la résolution de l'écran. On calcule donc une
  // taille de stage Konva qui rentre dans le conteneur réel, et on compense avec un
  // scale Konva : les coordonnées des zones (espace logique) restent inchangées.
  function getResponsiveStageSize(container, dataWidth, dataHeight) {
    const containerWidth = container.clientWidth || dataWidth;
    const scale = containerWidth > 0 ? Math.min(1, containerWidth / dataWidth) : 1;
    return {
      width: Math.round(dataWidth * scale),
      height: Math.round(dataHeight * scale),
      scale: scale,
    };
  }

  // Comme getResponsiveStageSize(), mais agrandit aussi le plan pour remplir la largeur
  // du conteneur (pas seulement le rétrécir). Utilisé pour la vue d'un local : la bounding
  // box d'une seule zone (quelques centaines de px logiques) est presque toujours bien
  // plus petite que la carte Bootstrap qui la contient, sinon le plan reste minuscule dans
  // un grand encart vide. `maxHeight` borne la hauteur finale pour éviter un agrandissement
  // disproportionné sur un local très étroit/haut.
  function getFillStageSize(container, dataWidth, dataHeight, maxHeight) {
    const containerWidth = container.clientWidth || dataWidth;
    // Toujours remplir la largeur du conteneur : l'encart Bootstrap peut être bien plus
    // large que la bounding-box de la zone, en particulier pour les zones portrait.
    const scale = containerWidth > 0 ? containerWidth / dataWidth : 1;
    // La hauteur est proportionnelle ; si elle dépasse maxHeight, on plafonne le stage
    // mais on garde le scale large (la partie basse reste accessible via le panning).
    const fullHeight = Math.round(dataHeight * scale);
    const stageHeight = maxHeight ? Math.min(fullHeight, maxHeight) : fullHeight;
    return {
      width: Math.round(containerWidth),
      height: stageHeight,
      scale: scale,
    };
  }

  // Zoom à la molette centré sur le curseur (recette standard Konva) : ajuste le scale
  // du stage par crans multiplicatifs, et compense la position pour que le point sous le
  // curseur reste fixe à l'écran pendant le zoom.
  const WHEEL_ZOOM_FACTOR = 1.08;
  const WHEEL_ZOOM_MIN_SCALE = 0.05;
  const WHEEL_ZOOM_MAX_SCALE = 20;

  // `getGroups` (optionnel) retourne le dict {id -> Konva.Group} des objets posés au
  // moment de l'appel — pour réajuster leur texte/bordure à taille d'écran constante à
  // chaque cran de zoom (cf. rescaleObjectGroups). Un getter (et non le dict directement)
  // car ce dict est peuplé/modifié après l'appel à attachWheelZoom (placement, suppression).
  function attachWheelZoom(stage, getGroups) {
    stage.on('wheel', function (e) {
      e.evt.preventDefault();
      const oldScale = stage.scaleX();
      const pointer = stage.getPointerPosition();
      if (!pointer) return;
      const mousePointTo = {
        x: (pointer.x - stage.x()) / oldScale,
        y: (pointer.y - stage.y()) / oldScale,
      };
      const direction = e.evt.deltaY > 0 ? -1 : 1;
      let newScale = direction > 0 ? oldScale * WHEEL_ZOOM_FACTOR : oldScale / WHEEL_ZOOM_FACTOR;
      newScale = Math.max(WHEEL_ZOOM_MIN_SCALE, Math.min(WHEEL_ZOOM_MAX_SCALE, newScale));
      stage.scale({ x: newScale, y: newScale });
      stage.position({
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      });
      if (getGroups) rescaleObjectGroups(getGroups(), newScale);
      stage.batchDraw();
    });
  }

  // Déplacement du plan en maintenant le clic gauche enfoncé sur une zone vide du
  // canvas (pas sur un objet posé) : on rend le stage lui-même draggable — Konva route
  // déjà le mousedown vers le node le plus profond sous le curseur, donc un clic-glissé
  // démarré directement sur un objet déplace cet objet (son propre Group draggable),
  // tandis qu'un clic-glissé sur le fond déplace le stage (panoramique).
  function attachPanning(stage) {
    stage.draggable(true);
    stage.on('dragstart', function () {
      stage.container().style.cursor = 'grabbing';
    });
    stage.on('dragend', function () {
      stage.container().style.cursor = '';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    initLayerPanel();
    // requestAnimationFrame garantit que le premier layout CSS est résolu avant de lire
    // container.clientWidth — sans ça, Bootstrap n'a pas encore calculé les largeurs de
    // colonnes et clientWidth vaut 0, ce qui force getResponsiveStageSize à utiliser
    // dataWidth en fallback et crée un stage surdimensionné (rendu flou / recadré).
    requestAnimationFrame(function () {
      const canvas = initCanvas();
      initAssociationPanel(canvas);
      initPlacedObjectsUI(canvas);
    });
    initLocationCanvas();
    // Si l'onglet Zone n'est pas actif au chargement (clientWidth=0), réessayer dès que
    // Bootstrap l'affiche — shown.bs.tab se déclenche après la transition complète, donc
    // clientWidth est garanti correct à ce moment.
    document.addEventListener('shown.bs.tab', initLocationCanvas);
  });

  function initLayerPanel() {
    const panel = document.getElementById('np-layer-panel');
    if (!panel) return;

    const layersUrl = panel.dataset.layersUrl;
    const confirmUrl = panel.dataset.confirmUrl;
    const confirmPreviewUrl = panel.dataset.confirmPreviewUrl;
    const csrftoken = getCsrfToken();
    // Présence de zones déjà chargées sur la page = c'est un réimport (le calque avait déjà
    // été confirmé une première fois) : on passe alors par le récapitulatif avant
    // d'appliquer, plutôt que d'écraser silencieusement des associations/objets posés
    // existants. Un tout premier import (aucune zone encore) reste immédiat.
    const isReimport = !!document.getElementById('np-zones-data');

    let selectedLayer = null;

    function renderError(message) {
      panel.innerHTML = `<p class="text-danger mb-0">${message}</p>`;
    }

    const networkErrorConfirm = gettext('Erreur réseau lors de la confirmation du calque.');

    function doConfirm(layerName, confirmBtn) {
      confirmBtn.disabled = true;
      fetch(confirmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrftoken },
        body: JSON.stringify({ layer_name: layerName }),
      })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data.error) { renderError(data.error); return; }
          window.location.reload();
        })
        .catch(function () { renderError(networkErrorConfirm); });
    }

    // Affiche "X zone(s) inchangée(s), Y zone(s) supprimée(s) (Z objet(s) posé(s) retirés),
    // W nouvelle(s) zone(s)" avec un bouton "Appliquer" explicite — appelé uniquement pour
    // un réimport (cf. isReimport), jamais pour le tout premier import.
    function renderConfirmSummary(layerName, summary) {
      panel.innerHTML = '';
      const message = document.createElement('p');
      message.textContent = interpolate(
        gettext(
          '%(unchanged)s zone(s) inchangée(s), %(removed)s zone(s) supprimée(s) ' +
          '(%(objects)s objet(s) posé(s) seront retirés), %(created)s nouvelle(s) zone(s).'
        ),
        {
          unchanged: summary.unchanged, removed: summary.removed,
          objects: summary.placed_objects_removed, created: summary.created,
        },
        true
      );
      panel.appendChild(message);

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'btn btn-primary me-2';
      applyBtn.textContent = gettext('Appliquer');
      applyBtn.addEventListener('click', function () { doConfirm(layerName, applyBtn); });
      panel.appendChild(applyBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-outline-secondary';
      cancelBtn.textContent = gettext('Annuler');
      cancelBtn.addEventListener('click', function () { window.location.reload(); });
      panel.appendChild(cancelBtn);
    }

    function renderLayers(layers) {
      if (!layers.length) {
        renderError(gettext('Aucun calque trouvé dans ce fichier DXF.'));
        return;
      }

      const list = document.createElement('div');
      list.className = 'list-group mb-3';

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'btn btn-primary';
      confirmBtn.textContent = gettext('Confirmer ce calque');
      confirmBtn.disabled = true;

      layers.forEach(function (layer) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-group-item list-group-item-action';
        btn.textContent = layer;
        btn.addEventListener('click', function () {
          selectedLayer = layer;
          Array.from(list.children).forEach(function (el) { el.classList.remove('active'); });
          btn.classList.add('active');
          confirmBtn.disabled = false;
          previewLayer(layer);
        });
        list.appendChild(btn);
      });

      confirmBtn.addEventListener('click', function () {
        if (!selectedLayer) return;
        if (!isReimport || !confirmPreviewUrl) {
          doConfirm(selectedLayer, confirmBtn);
          return;
        }
        confirmBtn.disabled = true;
        fetch(confirmPreviewUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrftoken },
          body: JSON.stringify({ layer_name: selectedLayer }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) { renderError(data.error); return; }
            renderConfirmSummary(selectedLayer, data.summary);
          })
          .catch(function () { renderError(networkErrorConfirm); });
      });

      panel.innerHTML = '';
      panel.appendChild(list);
      panel.appendChild(confirmBtn);
    }

    panel.innerHTML = `<p class="text-muted mb-0">${gettext('Lecture des calques du fichier DXF…')}</p>`;
    fetch(layersUrl)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { renderError(data.error); return; }
        renderLayers(data.layers || []);
      })
      .catch(function () { renderError(gettext('Erreur réseau lors de la lecture des calques.')); });
  }

  // Aperçu en lecture seule d'un calque, appelé à chaque clic sur un calque
  // différent dans le panneau de sélection (avant confirmation).
  function previewLayer(layerName) {
    const container = document.getElementById('np-preview-canvas');
    if (!container) return;

    const baseUrl = container.dataset.previewUrl;
    const width = parseInt(container.dataset.width, 10) || 1200;
    const height = parseInt(container.dataset.height, 10) || 800;

    container.innerHTML = `<p class="text-muted p-3 mb-0">${gettext("Chargement de l'aperçu…")}</p>`;

    fetch(`${baseUrl}?layer=${encodeURIComponent(layerName)}`)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          container.innerHTML = `<p class="text-danger p-3 mb-0">${data.error}</p>`;
          return;
        }
        const strokes = data.strokes || [];
        if (!strokes.length) {
          container.innerHTML = `<p class="text-muted p-3 mb-0">${gettext('Aucun élément trouvé sur ce calque.')}</p>`;
          return;
        }
        if (typeof Konva === 'undefined') {
          container.innerHTML = `<p class="text-danger p-3 mb-0">${gettext("Konva.js n'a pas pu être chargé.")}</p>`;
          return;
        }

        container.innerHTML = '';
        const size = getResponsiveStageSize(container, width, height);
        container.style.height = size.height + 'px';
        const stage = new Konva.Stage({
          container: 'np-preview-canvas',
          width: size.width,
          height: size.height,
          scaleX: size.scale,
          scaleY: size.scale,
          pixelRatio: window.devicePixelRatio || 1,
        });
        const layer = new Konva.Layer();
        stage.add(layer);

        strokes.forEach(function (stroke) {
          const points = [];
          stroke.points.forEach(function (p) { points.push(p[0], p[1]); });
          layer.add(new Konva.Line({
            points: points,
            closed: stroke.closed,
            fill: stroke.closed ? COLORS.default.fill : undefined,
            stroke: COLORS.default.stroke,
            strokeWidth: stroke.closed ? 2 : 1,
          }));
        });

        layer.draw();
      })
      .catch(function () {
        container.innerHTML = `<p class="text-danger p-3 mb-0">${gettext("Erreur réseau lors de l'aperçu du calque.")}</p>`;
      });
  }

  // --- Rendu des objets placés (Device/Rack) : partagé entre la vue du plan (initCanvas)
  // et la vue d'un local (initLocationCanvas). ---

  const NAME_POSITIONS = [
    ['top', gettext('En haut')], ['bottom', gettext('En bas')], ['left', gettext('À gauche')],
    ['right', gettext('À droite')], ['center', gettext('Au centre')],
  ];

  function shapeHalfExtents(shapeNode) {
    if (shapeNode instanceof Konva.Circle) {
      const r = shapeNode.radius();
      return { hw: r, hh: r };
    }
    return { hw: shapeNode.width() / 2, hh: shapeNode.height() / 2 };
  }

  // Test d'appartenance point/polygone (ray casting) — nécessaire car une simple bounding
  // box ne suffit pas pour une zone non convexe (redans/niches dans le tracé du mur) :
  // un point peut être dans la bbox sans être dans le polygone réel.
  function pointInPolygon(x, y, polygon) {
    let inside = false;
    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
      const xi = polygon[i][0], yi = polygon[i][1];
      const xj = polygon[j][0], yj = polygon[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Coins d'un rectangle centré sur (cx, cy), de demi-dimensions hw/hh, tourné de
  // rotationDeg degrés.
  function rectCorners(cx, cy, hw, hh, rotationDeg) {
    const rad = (rotationDeg || 0) * Math.PI / 180;
    const cos = Math.cos(rad), sin = Math.sin(rad);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(function (p) {
      return [cx + p[0] * cos - p[1] * sin, cy + p[0] * sin + p[1] * cos];
    });
  }

  function crossProduct(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  // Vrai uniquement si les segments se croisent "proprement" (l'un traverse réellement
  // l'autre). Un simple contact — une extrémité posée exactement sur l'autre segment, ou
  // un alignement bord-à-bord — ne compte pas comme un croisement : c'est précisément ce
  // qui permet à un objet posé exactement à plat contre un mur (son bord coïncide alors
  // avec un segment du polygone) de rester valide, sans pour autant laisser passer un
  // vrai chevauchement.
  function segmentsCrossProperly(p1, p2, p3, p4) {
    const d1 = crossProduct(p3, p4, p1), d2 = crossProduct(p3, p4, p2);
    const d3 = crossProduct(p1, p2, p3), d4 = crossProduct(p1, p2, p4);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  }

  function distanceToSegment(x, y, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 1e-9) return Math.hypot(x - a[0], y - a[1]);
    let t = ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(x - (a[0] + t * dx), y - (a[1] + t * dy));
  }

  function polygonEdges(polygon) {
    return polygon.map(function (p, i) { return [p, polygon[(i + 1) % polygon.length]]; });
  }

  // Aire signée (formule du lacet) — positive si le polygone est défini dans le sens
  // anti-horaire, négative dans le sens horaire. Utilisée pour trier par taille et pour
  // détecter les zones imbriquées (centroïde d'une petite zone à l'intérieur d'une grande).
  function polygonSignedArea(polygon) {
    let a = 0;
    for (let i = 0, n = polygon.length; i < n; i++) {
      const j = (i + 1) % n;
      a += polygon[i][0] * polygon[j][1] - polygon[j][0] * polygon[i][1];
    }
    return a / 2;
  }

  // Construit le SVG path data d'un polygone multi-anneaux pour Konva.Path.
  // Utilisé avec fillRule:'evenodd' pour le rendu visuel : les aires intérieures sont
  // transparentes sans aucun artefact de seam. Séparé de bridgeHole (hit detection).
  function buildZoneSvgPath(outerPolygon, holePolygons) {
    function ringToPath(ring) {
      return ring.map(function (p, i) {
        return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1);
      }).join(' ') + ' Z';
    }
    return [outerPolygon].concat(holePolygons).map(ringToPath).join(' ');
  }

  // Épaisseur visuelle du tracé de zone (en pixels écran). Utilisée partout où le trait
  // de zone est dessiné (initCanvas, initLocationCanvas) et pour calculer le dégagement
  // d'aimantation : l'objet se cale à la face intérieure du trait, pas au centre du tracé.
  const ZONE_STROKE_SCREEN_PX = 1.0;

  // Marge de dégagement (en unités canvas) utilisée par isFootprintInsidePolygon et
  // projectOutsidePolygon — contextes sans accès direct au scale courant. La valeur 1.5
  // correspond à environ la moitié du trait de zone à l'échelle initiale typique d'un plan
  // de taille normale (≈ 0.3-0.5). Pour flushPositionForWall, le dégagement est recalculé
  // dynamiquement en fonction du scale courant (ZONE_STROKE_SCREEN_PX / 2 / scale).
  const WALL_CLEARANCE_PX = 1.5;

  function resolvedClearance(getScale) {
    return getScale ? ZONE_STROKE_SCREEN_PX / (2 * getScale()) : WALL_CLEARANCE_PX;
  }

  function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

  // Dichotomie sur le segment from→to : retourne le point valide le plus proche de `to`.
  function binarySearchPath(from, to, valid) {
    let lo = 0, hi = 1;
    let candidate = from;
    for (let i = 0; i < 8; i++) {
      const mid = (lo + hi) / 2;
      const p = { x: from.x + (to.x - from.x) * mid, y: from.y + (to.y - from.y) * mid };
      if (valid(p)) { lo = mid; candidate = p; } else { hi = mid; }
    }
    return candidate;
  }

  function urlFor(template, pk) { return template.replace('999999', pk); }

  // Vérifie que l'EMPRISE entière de l'objet (pas seulement son centre, ni seulement ses
  // coins) reste dans le polygone, avec une marge de dégagement par rapport au mur.
  // Vérifier uniquement le centre — ou même seulement les coins — ne suffit pas pour une
  // zone non convexe (redans/niches) : le tracé du polygone peut couper entre deux coins
  // chacun individuellement valides, laissant un bord de l'objet traverser le mur. On
  // teste donc explicitement qu'aucun bord du rectangle ne croise un bord du polygone.
  function isFootprintInsidePolygon(shape, cx, cy, hw, hh, rotationDeg, polygon, clearance) {
    if (clearance === undefined) clearance = WALL_CLEARANCE_PX;
    // Soustraire un epsilon au dégagement pour le check : flushPositionForWall place le
    // coin étendu exactement sur wall.coord, et pointInPolygon utilise des inégalités
    // strictes → un point sur la frontière est rejeté. L'epsilon (0.001 px canvas = ~0.003
    // px écran à scale 3) est invisible mais évite le rejet des positions de ras-du-mur.
    const c = Math.max(0, clearance - 1e-3);
    const ehw = hw + c, ehh = hh + c;
    if (!pointInPolygon(cx, cy, polygon)) return false;

    if (shape === 'circle') {
      const r = ehw;
      return polygonEdges(polygon).every(function (edge) {
        return distanceToSegment(cx, cy, edge[0], edge[1]) >= r;
      });
    }

    const corners = rectCorners(cx, cy, ehw, ehh, rotationDeg);
    if (!corners.every(function (c) { return pointInPolygon(c[0], c[1], polygon); })) return false;

    const rectEdges = corners.map(function (c, i) { return [c, corners[(i + 1) % corners.length]]; });
    const polyEdgeList = polygonEdges(polygon);
    return rectEdges.every(function (rEdge) {
      return polyEdgeList.every(function (pEdge) {
        return !segmentsCrossProperly(rEdge[0], rEdge[1], pEdge[0], pEdge[1]);
      });
    });
  }

  // Symétrique de isFootprintInsidePolygon : retourne true si l'emprise de l'objet CHEVAUCHE
  // le polygone (utilisé pour les zones d'exclusion — zones imbriquées dans la vue per-local).
  // Trois cas d'intersection couverts :
  //   (A) centre de l'objet dans le polygone
  //   (B) un coin de l'emprise dans le polygone
  //   (C) une arête de l'emprise croise une arête du polygone
  function footprintOverlapsPolygon(shape, cx, cy, hw, hh, rotationDeg, polygon, clearance) {
    if (clearance === undefined) clearance = WALL_CLEARANCE_PX;
    const c = Math.max(0, clearance - 1e-3);
    const ehw = hw + c, ehh = hh + c;
    if (pointInPolygon(cx, cy, polygon)) return true;
    if (shape === 'circle') {
      const r = ehw;
      return polygonEdges(polygon).some(function (edge) {
        return distanceToSegment(cx, cy, edge[0], edge[1]) < r;
      });
    }
    const corners = rectCorners(cx, cy, ehw, ehh, rotationDeg);
    if (corners.some(function (corner) { return pointInPolygon(corner[0], corner[1], polygon); })) return true;
    const rectEdgeList = corners.map(function (cr, i) { return [cr, corners[(i + 1) % corners.length]]; });
    const polyEdgeList = polygonEdges(polygon);
    return rectEdgeList.some(function (rEdge) {
      return polyEdgeList.some(function (pEdge) {
        return segmentsCrossProperly(rEdge[0], rEdge[1], pEdge[0], pEdge[1]);
      });
    });
  }

  // Demi-largeur/demi-hauteur LOCALES (avant rotation) de la forme — c'est ce
  // qu'attendent rectCorners()/isFootprintInsidePolygon(), qui appliquent eux-mêmes la
  // rotation complète. À ne pas confondre avec rectHalfExtents() (bounding box déjà
  // tournée, utilisée pour le positionnement contre un mur) : lui passer le résultat de
  // rectHalfExtents() ferait tourner deux fois la forme et donnerait une emprise fausse
  // pour toute rotation à 90/270° — c'était le bug derrière la « hitbox qui ne tourne pas
  // correctement » puis derrière « l'aimantation ne marche pas sur les murs verticaux ».
  function localHalfExtents(group) {
    return shapeHalfExtents(group.shapeNode);
  }

  function nearestPointOnSegment(x, y, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const lengthSq = dx * dx + dy * dy;
    if (lengthSq < 1e-9) return { point: a, tangent: [1, 0] };
    let t = ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));
    const len = Math.sqrt(lengthSq);
    return { point: [a[0] + t * dx, a[1] + t * dy], tangent: [dx / len, dy / len] };
  }

  // Calcule la position/rotation d'un objet "collé en permanence à l'extérieur" du
  // polygone de sa zone (option "Hors des murs") : projette (x, y) sur le point le plus
  // proche du périmètre (tous segments confondus, qu'ils soient orthogonaux ou non —
  // contrairement à findNearestWall() qui ne considère que les murs horizontaux/verticaux
  // pour l'aimantation intérieure), puis décale ce point vers l'EXTÉRIEUR du polygone
  // (la normale qui s'éloigne, déterminée par un test pointInPolygon plutôt que de
  // supposer un sens de parcours du polygone) de la demi-emprise de l'objet le long de
  // cette normale + une marge de dégagement. La rotation d'un rectangle est alignée sur
  // la tangente du segment, pour que son bord "arrière" affleure le mur ; sans effet pour
  // un cercle. Glisser le longe naturellement le périmètre, y compris autour des coins,
  // puisque le segment le plus proche change continûment avec (x, y).
  function projectOutsidePolygon(group, x, y, polygon, clearance) {
    if (!polygon || polygon.length < 3) return null;
    if (clearance === undefined) clearance = WALL_CLEARANCE_PX;
    const isCircle = group.placedData.shape === 'circle';
    const { hw, hh } = localHalfExtents(group);
    const halfExtentAlongNormal = isCircle ? hw : hh;

    let best = null;
    polygonEdges(polygon).forEach(function (edge) {
      const { point, tangent } = nearestPointOnSegment(x, y, edge[0], edge[1]);
      const dist = Math.hypot(x - point[0], y - point[1]);
      if (!best || dist < best.dist) best = { dist: dist, point: point, tangent: tangent };
    });
    if (!best) return null;

    const n1 = [-best.tangent[1], best.tangent[0]];
    const n2 = [best.tangent[1], -best.tangent[0]];
    const probeDist = 0.5;
    const probe = [best.point[0] + n1[0] * probeDist, best.point[1] + n1[1] * probeDist];
    const outward = pointInPolygon(probe[0], probe[1], polygon) ? n2 : n1;

    const offset = halfExtentAlongNormal + clearance;
    return {
      x: best.point[0] + outward[0] * offset,
      y: best.point[1] + outward[1] * offset,
      rotation: isCircle ? 0 : (Math.atan2(best.tangent[1], best.tangent[0]) * 180 / Math.PI),
    };
  }

  // Empêche de glisser un objet placé hors des limites de sa zone : sans ça, un drag un
  // peu trop rapide pousse l'objet hors du polygone (voire hors du canvas visible) et il
  // devient impossible à retrouver/re-sélectionner. `getPolygon` retourne le polygone de
  // la zone, dans le même espace de coordonnées que group.x()/y(). Toute position dont
  // l'emprise complète (coins compris) ne reste pas dans le polygone est rejetée.
  //
  // Si la position demandée est invalide, on ne revient pas brutalement à la dernière
  // position validée (ça « bloquait » l'objet dès qu'un seul échantillon de glissé tombait
  // sur une position invalide, même à quelques fractions de pixel d'un mur : un glissé
  // rapide pouvait alors figer l'objet bien avant le mur, sans raison visible — c'était le
  // bug des « collisions invisibles » près des murs). On cherche plutôt par dichotomie, sur
  // le segment dernière-position-valide → position-demandée, le point le plus proche du
  // mur qui reste valide : l'objet glisse ainsi jusqu'au mur au lieu de se figer en route.
  function makeDragBoundFunc(group, getPolygon, getScale, getExclusionPolygons) {
    let lastValidLocal = null;
    return function (pos) {
      const polygon = getPolygon();
      if (!polygon || polygon.length < 3) return pos;

      if (group.placedData.outside_wall) {
        // Option "Hors des murs" : l'objet est collé en permanence au périmètre, pas de
        // notion de position "invalide" à corriger par dichotomie — la projection est
        // toujours définie, donc on l'applique directement à chaque échantillon de glissé.
        const inverse = group.getParent().getAbsoluteTransform().copy().invert();
        const local = inverse.point(pos);
        const projected = projectOutsidePolygon(group, local.x, local.y, polygon, resolvedClearance(getScale));
        if (!projected) return pos;
        if (group.placedData.shape !== 'circle') {
          group.shapeNode.rotation(projected.rotation);
          group.placedData.rotation = projected.rotation;
        }
        return group.getParent().getAbsoluteTransform().point({ x: projected.x, y: projected.y });
      }

      const { hw, hh } = localHalfExtents(group);
      const rotation = group.placedData.shape === 'circle' ? 0 : (group.placedData.rotation || 0);
      const clearance = resolvedClearance(getScale);

      const inverseTransform = group.getParent().getAbsoluteTransform().copy().invert();
      const localPos = inverseTransform.point(pos);

      function valid(p) {
        if (!isFootprintInsidePolygon(group.placedData.shape, p.x, p.y, hw, hh, rotation, polygon, clearance)) {
          return false;
        }
        if (getExclusionPolygons) {
          const excl = getExclusionPolygons();
          for (let i = 0; i < excl.length; i++) {
            if (footprintOverlapsPolygon(group.placedData.shape, p.x, p.y, hw, hh, rotation, excl[i], clearance)) {
              return false;
            }
          }
        }
        return true;
      }

      if (lastValidLocal === null) {
        // Première utilisation : position courante du group, censée déjà être valide
        // (chargée depuis le serveur, ou posée au centre de la zone à la création).
        lastValidLocal = { x: group.x(), y: group.y() };
      }

      if (valid(localPos)) {
        lastValidLocal = { x: localPos.x, y: localPos.y };
        return pos;
      }

      // Glissement axial + traversée de coin : quand on pousse en diagonale vers un coin,
      // l'objet doit glisser le long du premier mur atteint, puis continuer dans le coin
      // plutôt que de se bloquer sur la diagonale. On calcule 5 candidats :
      //   direct  : dichotomie directe (comportement habituel)
      //   slideX  : glissé purement horizontal depuis lastValid → (localPos.x, lastValid.y)
      //   slideY  : glissé purement vertical  depuis lastValid → (lastValid.x, localPos.y)
      //   slideXY : depuis slideX, glissé vertical  → (slideX.x, localPos.y)   [coin H→V]
      //   slideYX : depuis slideY, glissé horizontal → (localPos.x, slideY.y)  [coin V→H]
      // On retient le candidat le plus proche de localPos (= qui a le plus progressé vers
      // la destination demandée).
      const last = lastValidLocal;
      const candDirect = binarySearchPath(last, localPos, valid);
      const slideX  = binarySearchPath(last,   { x: localPos.x, y: last.y    }, valid);
      const slideY  = binarySearchPath(last,   { x: last.x,     y: localPos.y }, valid);
      const slideXY = binarySearchPath(slideX, { x: slideX.x,   y: localPos.y }, valid);
      const slideYX = binarySearchPath(slideY, { x: localPos.x, y: slideY.y   }, valid);

      let best = candDirect;
      let bestDist = dist2(candDirect, localPos);
      [slideX, slideY, slideXY, slideYX].forEach(function (c) {
        const d = dist2(c, localPos);
        if (d < bestDist) { bestDist = d; best = c; }
      });

      lastValidLocal = best;
      return group.getParent().getAbsoluteTransform().point(best);
    };
  }

  function positionLabel(label, shapeNode, namePosition, scale) {
    const { hw, hh } = shapeHalfExtents(shapeNode);
    const pad = 4 / (scale || 1);
    const w = label.width();
    const h = label.height();
    switch (namePosition) {
      case 'top':
        label.offsetX(w / 2); label.offsetY(h);
        label.x(0); label.y(-hh - pad);
        break;
      case 'bottom':
        label.offsetX(w / 2); label.offsetY(0);
        label.x(0); label.y(hh + pad);
        break;
      case 'left':
        label.offsetX(w); label.offsetY(h / 2);
        label.x(-hw - pad); label.y(0);
        break;
      case 'right':
        label.offsetX(0); label.offsetY(h / 2);
        label.x(hw + pad); label.y(0);
        break;
      default: // center
        label.offsetX(w / 2); label.offsetY(h / 2);
        label.x(0); label.y(0);
    }
  }

  // Construit un Konva.Group pour un PlacedObject sérialisé (voir _serialize_placed_object
  // côté serveur). `offsetX/offsetY` permettent de recentrer sur l'espace local d'une zone
  // (vue d'un local) ; laisser à 0 pour l'espace global du plan. `stageScale` est le
  // facteur de zoom appliqué au Konva.Stage parent (voir getResponsiveStageSize() /
  // getFillStageSize()) : sans compensation, la taille de police du nom serait multipliée
  // par ce zoom (ex: x5-6 dans la vue d'un local agrandie pour remplir la carte), donc on
  // divise la taille de police voulue par ce facteur pour obtenir un texte à taille d'écran
  // constante quel que soit le niveau de zoom.
  // Épaisseur de trait et taille de police "à l'écran" (px), constantes quel que soit le
  // zoom courant du stage — cf. rescaleObjectGroups(), qui réapplique ces tailles à
  // chaque cran de zoom à la molette pour que le texte/les bordures restent lisibles au
  // lieu de grossir/rétrécir avec le contenu du plan.
  const BASE_STROKE_PX = 1;
  const BASE_FONT_PX = 12;
  const BASE_ZONE_LABEL_PX = 12;
  // Marge de "préhension" ajoutée autour de chaque forme pour le clic/glissé (Konva
  // hitStrokeWidth) : un device de quelques cm sur un grand plan peut ne mesurer que
  // 2-3px à l'écran, ce qui le rend quasi impossible à attraper précisément à la souris.
  // Cette marge ne change rien au rendu visuel, seulement à la zone cliquable.
  const HIT_PADDING_PX = 24;

  function buildPlacedGroup(obj, mmPerPx, offsetX, offsetY, editable, stageScale) {
    const scale = mmPerPx || 1;
    const strokeWidthPx = BASE_STROKE_PX / (stageScale || 1);
    const hitStrokeWidthPx = HIT_PADDING_PX / (stageScale || 1);
    const group = new Konva.Group({
      x: obj.x - offsetX,
      y: obj.y - offsetY,
      draggable: !!editable,
    });

    let shapeNode;
    if (obj.shape === 'circle') {
      const radius = ((obj.diameter_mm || 40) / scale) / 2;
      shapeNode = new Konva.Circle({
        radius: radius,
        fill: 'rgba(156,39,176,0.25)', stroke: '#9c27b0', strokeWidth: strokeWidthPx,
        hitStrokeWidth: hitStrokeWidthPx,
      });
    } else {
      const w = (obj.width_mm || 40) / scale;
      const h = (obj.depth_mm || 40) / scale;
      shapeNode = new Konva.Rect({
        width: w, height: h, offsetX: w / 2, offsetY: h / 2,
        rotation: obj.rotation || 0,
        fill: 'rgba(255,152,0,0.25)', stroke: '#fb8c00', strokeWidth: strokeWidthPx,
        hitStrokeWidth: hitStrokeWidthPx,
      });
    }
    group.add(shapeNode);

    const fontSizePx = BASE_FONT_PX / (stageScale || 1);
    const label = new Konva.Text({
      text: obj.name || '', fontSize: fontSizePx, fill: '#1a1a1a', listening: false,
    });
    positionLabel(label, shapeNode, obj.name_position || 'center', stageScale);
    group.add(label);

    group.placedData = obj;
    group.shapeNode = shapeNode;
    group.labelNode = label;
    return group;
  }

  // Réapplique BASE_STROKE_PX/BASE_FONT_PX à tous les objets posés en fonction du zoom
  // courant (appelé à chaque cran de zoom à la molette) : sans ça, le texte et les
  // bordures grossiraient/rétréciraient avec le contenu du plan au lieu de rester
  // lisibles à taille d'écran constante.
  function rescaleObjectGroups(objectGroups, scale) {
    Object.keys(objectGroups).forEach(function (id) {
      const group = objectGroups[id];
      if (!group.shapeNode || !group.labelNode) return;
      group.shapeNode.strokeWidth(BASE_STROKE_PX / scale);
      group.shapeNode.hitStrokeWidth(HIT_PADDING_PX / scale);
      group.labelNode.fontSize(BASE_FONT_PX / scale);
      positionLabel(group.labelNode, group.shapeNode, group.placedData.name_position || 'center', scale);
    });
  }

  // Vrai si `rotation` (degrés, signe quelconque) est un multiple exact de 90° : seules
  // ces rotations alignent le rectangle sur des murs orthogonaux, condition requise pour
  // l'aimantation au mur (case à cocher, et l'aimant pendant le glissé).
  function isAxisAlignedRotation(rotation) {
    return ((rotation % 90) + 90) % 90 === 0;
  }

  // Demi-largeur/demi-hauteur de la bounding box axis-aligned d'un Konva.Rect selon sa
  // rotation courante : une rotation de 90/270° échange largeur et hauteur visuelles.
  // N'est appelé que pour des rotations multiples de 90 (condition déjà imposée par
  // initPropertiesPanel avant d'autoriser l'aimantation). Résultat à passer à
  // flushPositionForWall()/findNearestWall(), jamais à isFootprintInsidePolygon() (qui
  // attend les half-extents LOCALES de localHalfExtents() et applique elle-même la
  // rotation — lui passer cette AABB déjà tournée la appliquerait deux fois).
  function rectHalfExtents(shapeNode, rotation) {
    const w = shapeNode.width(), h = shapeNode.height();
    const normalized = (((Math.round(rotation / 90) * 90) % 180) + 180) % 180;
    if (normalized === 90) return { hw: h / 2, hh: w / 2 };
    return { hw: w / 2, hh: h / 2 };
  }

  // Seuil de distance (en px logiques) sous lequel on bascule l'ancrage vers un autre
  // mur pendant un glissé, et force du magnétisme "doux" appliqué à chaque dragmove
  // (0 = aucune attraction, 1 = blocage rigide instantané).
  const SNAP_RESNAP_THRESHOLD_PX = 20;
  const SNAP_PULL_STRENGTH = 0.35;

  // Cherche le mur (segment orthogonal du polygone de la zone) le plus proche du centre
  // (centerX, centerY) et renvoie {axis, coord, distance}, ou null. Les segments non
  // orthogonaux (murs en biais) sont ignorés : l'aimantation ne s'applique qu'aux
  // rectangles à rotation multiple de 90°, donc on ne peut les aligner qu'à des murs
  // eux-mêmes orthogonaux. `minSegmentLength` ignore les petits segments (redans, niches)
  // plus courts que l'objet lui-même : sans ce filtre, un objet proche d'un coin peut
  // "accrocher" un minuscule segment voisin du vrai mur, et finir décalé sur le mauvais
  // axe — visuellement, l'objet traverse alors le vrai mur au lieu de s'y coller.
  function findNearestWall(centerX, centerY, polygon, minSegmentLength) {
    let best = null;
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i];
      const b = polygon[(i + 1) % polygon.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const length = Math.hypot(dx, dy);
      if (length < 1e-6 || length < minSegmentLength) continue;
      const isHorizontal = Math.abs(dy) <= Math.abs(dx) * 0.05;
      const isVertical = Math.abs(dx) <= Math.abs(dy) * 0.05;
      if (!isHorizontal && !isVertical) continue;

      if (isHorizontal) {
        const wallY = (a[1] + b[1]) / 2;
        const minX = Math.min(a[0], b[0]), maxX = Math.max(a[0], b[0]);
        const clampedX = Math.max(minX, Math.min(maxX, centerX));
        const dist = Math.hypot(centerX - clampedX, centerY - wallY);
        if (!best || dist < best.distance) best = { distance: dist, axis: 'y', coord: wallY };
      } else {
        const wallX = (a[0] + b[0]) / 2;
        const minY = Math.min(a[1], b[1]), maxY = Math.max(a[1], b[1]);
        const clampedY = Math.max(minY, Math.min(maxY, centerY));
        const dist = Math.hypot(centerX - wallX, centerY - clampedY);
        if (!best || dist < best.distance) best = { distance: dist, axis: 'x', coord: wallX };
      }
    }
    return best;
  }

  function findBestWall(x, y, polygons, minSegmentLength) {
    let best = null;
    polygons.forEach(function (poly) {
      const w = findNearestWall(x, y, poly, minSegmentLength);
      if (w && (!best || w.distance < best.distance)) best = w;
    });
    return best;
  }

  // Position recentrée pour que le bord de l'objet touche exactement `wall` (sans le
  // traverser), en conservant le côté courant du centre par rapport au mur.
  // Le trait du mur est centré sur le tracé du polygone (moitié dedans, moitié dehors) :
  // "à plat contre le mur" doit donc viser la face intérieure réelle du mur, c'est-à-dire
  // le tracé du polygone décalé de WALL_CLEARANCE_PX vers l'intérieur — pas le tracé brut
  // (qui placerait l'objet à cheval sur le trait du mur).
  function flushPositionForWall(centerX, centerY, hw, hh, wall, clearance) {
    if (!wall) return null;
    if (clearance === undefined) clearance = WALL_CLEARANCE_PX;
    if (wall.axis === 'y') {
      const sign = centerY >= wall.coord ? 1 : -1;
      return { x: centerX, y: wall.coord + sign * (hh + clearance) };
    }
    const sign = centerX >= wall.coord ? 1 : -1;
    return { x: wall.coord + sign * (hw + clearance), y: centerY };
  }

  // Magnétisme "doux" pendant le glissé d'un objet placé : tant que la case "Aimanter au
  // mur" est active, l'objet reste librement déplaçable mais une force d'attraction le
  // tire en permanence vers son mur d'ancrage courant (résistance, pas un blocage rigide).
  // L'ancrage est recalculé au début de chaque glissé (mur le plus proche), et remplacé
  // automatiquement dès qu'un autre mur passe sous SNAP_RESNAP_THRESHOLD_PX — en dehors de
  // ce seuil, aucun changement d'ancrage automatique. `getPolygon()` retourne le polygone
  // de la zone dans le même espace de coordonnées que group.x()/y() (global pour la vue
  // du plan, local-décalé pour la vue d'un local).
  function attachWallMagnet(group, getPolygon, getScale, getSnapPolygons, getExclusionPolygons) {
    let anchorWall = null;

    function isEligible() {
      if (group.placedData.shape === 'circle') return false;
      return isAxisAlignedRotation(group.placedData.rotation || 0);
    }

    function halfExtents() {
      if (group.placedData.shape === 'circle') {
        const r = group.shapeNode.radius();
        return { hw: r, hh: r };
      }
      return rectHalfExtents(group.shapeNode, group.placedData.rotation || 0);
    }

    group.on('dragstart', function () {
      anchorWall = null;
      if (!group.placedData.snap_to_wall || !isEligible()) return;
      const polygon = getPolygon();
      if (!polygon) return;
      const { hw, hh } = halfExtents();
      const snapExtra = getSnapPolygons ? getSnapPolygons() : [];
      anchorWall = findBestWall(group.x(), group.y(), [polygon].concat(snapExtra), Math.max(hw, hh) * 0.5);
    });

    group.on('dragmove', function () {
      if (!group.placedData.snap_to_wall || !isEligible() || !anchorWall) return;
      const polygon = getPolygon();
      if (!polygon) return;
      const snapExtra = getSnapPolygons ? getSnapPolygons() : [];
      const exclusions = getExclusionPolygons ? getExclusionPolygons() : [];
      const { hw, hh } = halfExtents();
      const x = group.x(), y = group.y();

      const nearest = findBestWall(x, y, [polygon].concat(snapExtra), Math.max(hw, hh) * 0.5);
      if (nearest && nearest.distance <= SNAP_RESNAP_THRESHOLD_PX &&
          (nearest.axis !== anchorWall.axis || nearest.coord !== anchorWall.coord)) {
        anchorWall = nearest;
      }

      const clearance = resolvedClearance(getScale);
      const target = flushPositionForWall(x, y, hw, hh, anchorWall, clearance);
      if (target) {
        const rotation = group.placedData.rotation || 0;
        const pulledX = x + (target.x - x) * SNAP_PULL_STRENGTH;
        const pulledY = y + (target.y - y) * SNAP_PULL_STRENGTH;
        // L'aimant déplace l'objet directement (sans repasser par dragBoundFunc) : on doit
        // donc revalider ici son emprise complète, sinon le magnétisme peut lui-même
        // pousser l'objet à travers un mur voisin (ex. près d'un redan/niche). On valide
        // avec les half-extents LOCALES (cf. localHalfExtents) et non l'AABB de
        // halfExtents() ci-dessus : isFootprintInsidePolygon applique elle-même la
        // rotation, donc lui passer une AABB déjà tournée la appliquerait deux fois — ce
        // qui rendait à tort la validation invalide pour tout rectangle tourné à 90/270°
        // (typiquement un objet posé en long contre un mur vertical).
        const { hw: localHw, hh: localHh } = localHalfExtents(group);
        if (isFootprintInsidePolygon(group.placedData.shape, pulledX, pulledY, localHw, localHh, rotation, polygon, clearance) &&
            exclusions.every(function (excl) {
              return !footprintOverlapsPolygon(group.placedData.shape, pulledX, pulledY, localHw, localHh, rotation, excl, clearance);
            })) {
          group.x(pulledX);
          group.y(pulledY);
        }
      }
    });

    return {
      // À appeler en fin de glissé (dragend) : se cale complètement (à plat, sans
      // traverser) contre le mur d'ancrage courant. Renvoie true si un ancrage était actif.
      finalize: function () {
        if (!group.placedData.snap_to_wall || !isEligible() || !anchorWall) return false;
        const { hw, hh } = halfExtents();
        const clearance = resolvedClearance(getScale);
        const target = flushPositionForWall(group.x(), group.y(), hw, hh, anchorWall, clearance);
        if (!target) return false;
        const polygon = getPolygon();
        const exclusions = getExclusionPolygons ? getExclusionPolygons() : [];
        const rotation = group.placedData.rotation || 0;
        const { hw: localHw, hh: localHh } = localHalfExtents(group);
        if (polygon && !isFootprintInsidePolygon(group.placedData.shape, target.x, target.y, localHw, localHh, rotation, polygon, clearance)) {
          return false;
        }
        if (exclusions.some(function (excl) {
          return footprintOverlapsPolygon(group.placedData.shape, target.x, target.y, localHw, localHh, rotation, excl, clearance);
        })) {
          return false;
        }
        group.x(target.x);
        group.y(target.y);
        return true;
      },
    };
  }

  // Rotation par clic droit : chaque clic droit sur un objet placé tourne sa forme de 90°
  // (boucle 0→90→180→270→0…). Remplace l'ancien mode "rotation auto au mur" — l'utilisateur
  // choisit explicitement quand tourner plutôt qu'une rotation automatique pendant le glissé.
  // Sans effet pour les cercles. La rotation est rejetée (rien ne se passe) si elle ferait
  // sortir l'emprise de l'objet de la zone à sa position actuelle. `onRotated(group)` est
  // appelé après une rotation effective, pour persister côté serveur et rafraîchir l'UI.
  function attachRightClickRotate(group, getPolygon, onRotated) {
    group.on('contextmenu', function (e) {
      e.evt.preventDefault();
      if (group.placedData.shape === 'circle') return;
      // Hors des murs : la rotation est entièrement dérivée de l'angle du mur contre
      // lequel l'objet est collé (cf. projectOutsidePolygon) — une rotation manuelle n'a
      // pas de sens et serait de toute façon écrasée au prochain glissé.
      if (group.placedData.outside_wall) return;
      const polygon = getPolygon();
      if (!polygon) return;
      const current = group.shapeNode.rotation();
      const candidate = ((Math.round(current / 90) * 90 + 90) % 360 + 360) % 360;
      const { hw, hh } = localHalfExtents(group);
      if (!isFootprintInsidePolygon('rect', group.x(), group.y(), hw, hh, candidate, polygon)) return;
      group.shapeNode.rotation(candidate);
      group.placedData.rotation = candidate;
      group.getLayer().draw();
      if (onRotated) onRotated(group);
    });
  }

  // Sauvegarde x/y (et tout champ supplémentaire dans `extra`, ex. rotation) d'un objet
  // placé — utilisé après un glissé et après une rotation par clic droit, dans les deux
  // vues (plan complet et local). `url` est déjà résolue (cf. urlFor()).
  function persistPlacedObject(url, obj, extra) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
      body: JSON.stringify(Object.assign({ x: obj.x, y: obj.y }, extra)),
    });
  }

  // Recentre group/obj sur le mur le plus proche de la zone si une aimantation est
  // possible (rectangle, rotation multiple de 90°) ; ne fait rien sinon. Action ponctuelle
  // (activation de la case "Aimanter au mur") — le magnétisme pendant le glissé est géré
  // par attachWallMagnet(). Ne persiste pas : appelant responsable de l'enregistrement.
  // `getPolygon(group)` retourne le polygone de la zone (vue du plan : dérivé du group,
  // chaque objet pouvant être dans une zone différente ; vue d'un local : toujours la même
  // zone, l'argument est alors ignoré). `offsetX/offsetY` décalent group.x()/y() (espace
  // local à la zone, vue d'un local) vers obj.x/obj.y (espace global du plan) — laisser
  // à 0 pour la vue du plan, où les deux espaces coïncident déjà.
  function makeTrySnap(getPolygon, offsetX, offsetY, getScale, getSnapPolygons, getExclusionPolygons) {
    return function (group) {
      const obj = group.placedData;
      if (obj.shape === 'circle') return false;
      const rotation = obj.rotation || 0;
      if (!isAxisAlignedRotation(rotation)) return false;
      const polygon = getPolygon(group);
      if (!polygon) return false;
      const snapExtra = getSnapPolygons ? getSnapPolygons() : [];
      const exclusions = getExclusionPolygons ? getExclusionPolygons(group) : [];
      const { hw, hh } = rectHalfExtents(group.shapeNode, rotation);
      const wall = findBestWall(group.x(), group.y(), [polygon].concat(snapExtra), Math.max(hw, hh) * 0.5);
      const clearance = resolvedClearance(getScale);
      const snapped = flushPositionForWall(group.x(), group.y(), hw, hh, wall, clearance);
      if (!snapped) return false;
      const { hw: localHw, hh: localHh } = localHalfExtents(group);
      if (!isFootprintInsidePolygon(obj.shape, snapped.x, snapped.y, localHw, localHh, rotation, polygon, clearance)) return false;
      if (exclusions.some(function (excl) {
        return footprintOverlapsPolygon(obj.shape, snapped.x, snapped.y, localHw, localHh, rotation, excl, clearance);
      })) return false;
      group.x(snapped.x);
      group.y(snapped.y);
      obj.x = snapped.x + offsetX;
      obj.y = snapped.y + offsetY;
      group.getLayer().draw();
      return true;
    };
  }

  // Équivalent de makeTrySnap() pour l'option "Hors des murs" : colle group/obj contre le
  // point le plus proche du périmètre, à l'extérieur (cf. projectOutsidePolygon). Action
  // ponctuelle (activation de la case) — le glissé permanent une fois actif est géré par
  // makeDragBoundFunc(). Fonctionne pour les rectangles ET les cercles (pas de restriction
  // de rotation, contrairement à makeTrySnap : la rotation est dérivée automatiquement).
  function makeTrySnapOutside(getPolygon, offsetX, offsetY, getScale) {
    return function (group) {
      const obj = group.placedData;
      const polygon = getPolygon(group);
      if (!polygon) return false;
      const clearance = resolvedClearance(getScale);
      const projected = projectOutsidePolygon(group, group.x(), group.y(), polygon, clearance);
      if (!projected) return false;
      group.x(projected.x);
      group.y(projected.y);
      if (obj.shape !== 'circle') {
        group.shapeNode.rotation(projected.rotation);
        obj.rotation = projected.rotation;
      }
      obj.x = projected.x + offsetX;
      obj.y = projected.y + offsetY;
      group.getLayer().draw();
      return true;
    };
  }

  // Affiche le panneau "Objets à placer" (tabs Racks / Devices non rackés) et gère
  // l'action "Placer" pour chaque ligne. `resolvePlaceUrl(item)` retourne l'URL de
  // placement à utiliser pour cet item (diffère entre la vue du plan, où chaque item
  // cible une zone différente, et la vue d'un local, où c'est toujours la même zone).
  function initPickablePanel(container, pickableUrl, resolvePlaceUrl, onPlaced) {
    if (!container) return null;
    const csrftoken = getCsrfToken();
    let activeTab = 'racks';
    let lastData = { racks: [], devices: [] };

    function renderRow(item) {
      const tr = document.createElement('tr');
      const tdName = document.createElement('td');
      if (item.url) {
        const link = document.createElement('a');
        link.href = item.url;
        link.textContent = item.name;
        tdName.appendChild(link);
      } else {
        tdName.textContent = item.name;
      }
      tr.appendChild(tdName);

      const tdAction = document.createElement('td');
      if (item.placeable) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-sm btn-outline-primary';
        btn.textContent = gettext('Placer');
        btn.addEventListener('click', function () {
          btn.disabled = true;
          const url = resolvePlaceUrl(item);
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrftoken },
            body: JSON.stringify({ object_type: item.object_type, object_id: item.object_id }),
          })
            .then(function (r) { return r.json(); })
            .then(function (data) {
              if (data.error) {
                btn.disabled = false;
                tdAction.innerHTML = '';
                const err = document.createElement('span');
                err.className = 'text-danger small';
                err.textContent = data.error;
                tdAction.appendChild(err);
                return;
              }
              if (onPlaced) onPlaced(data.object);
              refresh();
            })
            .catch(function () {
              btn.disabled = false;
            });
        });
        tdAction.appendChild(btn);
      } else {
        const span = document.createElement('span');
        span.className = 'text-muted small';
        span.textContent = gettext('Forme non configurée');
        tdAction.appendChild(span);
      }
      tr.appendChild(tdAction);
      return tr;
    }

    function render() {
      container.innerHTML = '';

      const nav = document.createElement('ul');
      nav.className = 'nav nav-tabs mb-2';
      [['racks', gettext('Racks')], ['devices', gettext('Devices non rackés')]].forEach(function (entry) {
        const key = entry[0], label = entry[1];
        const li = document.createElement('li');
        li.className = 'nav-item';
        const a = document.createElement('a');
        a.href = '#';
        a.className = 'nav-link' + (key === activeTab ? ' active' : '');
        a.textContent = label;
        a.addEventListener('click', function (e) {
          e.preventDefault();
          activeTab = key;
          render();
        });
        li.appendChild(a);
        nav.appendChild(li);
      });
      container.appendChild(nav);

      const items = lastData[activeTab] || [];
      if (!items.length) {
        const empty = document.createElement('p');
        empty.className = 'text-muted small mb-0';
        empty.textContent = gettext('Aucun objet disponible.');
        container.appendChild(empty);
        return;
      }

      const table = document.createElement('table');
      table.className = 'table table-sm mb-0';
      const tbody = document.createElement('tbody');
      items.forEach(function (item) { tbody.appendChild(renderRow(item)); });
      table.appendChild(tbody);
      container.appendChild(table);
    }

    function refresh() {
      return fetch(pickableUrl)
        .then(function (r) { return r.json(); })
        .then(function (data) {
          lastData = data;
          render();
        });
    }

    refresh();
    return { refresh: refresh };
  }

  // Affiche le panneau "Propriétés" pour un objet placé sélectionné sur le canvas.
  function initPropertiesPanel(container) {
    if (!container) return null;
    const csrftoken = getCsrfToken();

    function clear() {
      container.innerHTML = `<p class="text-muted mb-0">${gettext('Cliquez sur un objet placé sur le plan pour voir ses propriétés.')}</p>`;
    }
    clear();

    function show(group, urls, onSaved, onRemoved, onSnapNow, onSnapOutsideNow) {
      const obj = group.placedData;
      const isCircle = obj.shape === 'circle';
      container.innerHTML = '';

      const title = document.createElement('p');
      const titleStrong = document.createElement('strong');
      if (obj.url) {
        const titleLink = document.createElement('a');
        titleLink.href = obj.url;
        titleLink.textContent = obj.name;
        titleStrong.appendChild(titleLink);
      } else {
        titleStrong.textContent = obj.name;
      }
      title.appendChild(titleStrong);
      container.appendChild(title);

      let rotationInput = null;
      if (!isCircle) {
        const label = document.createElement('label');
        label.className = 'form-label';
        label.textContent = gettext('Rotation (°)');
        container.appendChild(label);
        rotationInput = document.createElement('input');
        rotationInput.type = 'number';
        rotationInput.step = '1';
        rotationInput.className = 'form-control mb-2';
        rotationInput.value = obj.rotation || 0;
        container.appendChild(rotationInput);
      }

      const snapWrapper = document.createElement('div');
      snapWrapper.className = 'form-check mb-2';
      const snapInput = document.createElement('input');
      snapInput.type = 'checkbox';
      snapInput.className = 'form-check-input';
      snapInput.id = 'np-snap-to-wall';
      snapInput.checked = !!obj.snap_to_wall;
      const snapLabel = document.createElement('label');
      snapLabel.className = 'form-check-label';
      snapLabel.htmlFor = 'np-snap-to-wall';
      snapLabel.textContent = gettext('Aimanter au mur');
      snapWrapper.appendChild(snapInput);
      snapWrapper.appendChild(snapLabel);
      container.appendChild(snapWrapper);

      const outsideWrapper = document.createElement('div');
      outsideWrapper.className = 'form-check mb-2';
      const outsideInput = document.createElement('input');
      outsideInput.type = 'checkbox';
      outsideInput.className = 'form-check-input';
      outsideInput.id = 'np-outside-wall';
      outsideInput.checked = !!obj.outside_wall;
      const outsideLabel = document.createElement('label');
      outsideLabel.className = 'form-check-label';
      outsideLabel.htmlFor = 'np-outside-wall';
      outsideLabel.textContent = gettext('Hors des murs');
      outsideWrapper.appendChild(outsideInput);
      outsideWrapper.appendChild(outsideLabel);
      container.appendChild(outsideWrapper);

      // "Hors des murs" colle l'objet en permanence au périmètre extérieur de la zone
      // (glisse-le-long-du-mur, cf. projectOutsidePolygon côté JS) ; mutuellement
      // exclusif avec "Aimanter au mur" (qui ne concerne que l'intérieur), et la rotation
      // devient entièrement automatique (dérivée de l'angle du mur), donc non éditable.
      function refreshAvailability() {
        const rotation = rotationInput ? (parseFloat(rotationInput.value) || 0) : 0;
        const allowed = !isCircle && isAxisAlignedRotation(rotation) && !outsideInput.checked;
        snapInput.disabled = !allowed;
        if (!allowed) snapInput.checked = false;
        if (rotationInput) rotationInput.disabled = !!outsideInput.checked;
      }
      refreshAvailability();

      const posLabel = document.createElement('label');
      posLabel.className = 'form-label';
      posLabel.textContent = gettext('Position du nom');
      container.appendChild(posLabel);
      const posSelect = document.createElement('select');
      posSelect.className = 'form-select mb-3';
      NAME_POSITIONS.forEach(function (entry) {
        const opt = document.createElement('option');
        opt.value = entry[0];
        opt.textContent = entry[1];
        if (entry[0] === obj.name_position) opt.selected = true;
        posSelect.appendChild(opt);
      });
      container.appendChild(posSelect);

      // Chaque changement (rotation, aimantation, position du nom) est enregistré
      // immédiatement côté serveur — pas de bouton "Enregistrer" séparé à cliquer.
      function persist() {
        const payload = {
          name_position: posSelect.value,
          snap_to_wall: snapInput.checked,
          outside_wall: outsideInput.checked,
          x: group.placedData.x,
          y: group.placedData.y,
        };
        if (rotationInput) {
          // Hors des murs : la rotation est pilotée par projectOutsidePolygon() (snap/drag),
          // pas par le champ (désactivé) qui peut être obsolète — on lit group.placedData
          // directement plutôt que la valeur affichée dans l'input.
          payload.rotation = outsideInput.checked
            ? (group.placedData.rotation || 0)
            : (parseFloat(rotationInput.value) || 0);
        }
        fetch(urls.update, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrftoken },
          body: JSON.stringify(payload),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (data.error) return;
            if (onSaved) onSaved(data.object);
          });
      }

      if (rotationInput) {
        rotationInput.addEventListener('input', refreshAvailability);
        rotationInput.addEventListener('change', function () {
          group.shapeNode.rotation(parseFloat(rotationInput.value) || 0);
          group.getLayer().draw();
          persist();
        });
      }

      snapInput.addEventListener('change', function () {
        if (snapInput.checked && onSnapNow) onSnapNow();
        persist();
      });

      outsideInput.addEventListener('change', function () {
        if (outsideInput.checked) {
          group.placedData.outside_wall = true;
          snapInput.checked = false;
          if (onSnapOutsideNow) onSnapOutsideNow();
          // onSnapOutsideNow() vient de recalculer group.placedData.rotation (snap
          // immédiat) ; resynchroniser le champ affiché (même désactivé) avant persist().
          if (rotationInput) rotationInput.value = group.placedData.rotation || 0;
        } else {
          group.placedData.outside_wall = false;
        }
        refreshAvailability();
        persist();
      });

      posSelect.addEventListener('change', persist);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'btn btn-outline-danger';
      removeBtn.textContent = gettext('Retirer du plan');
      removeBtn.addEventListener('click', function () {
        removeBtn.disabled = true;
        fetch(urls.remove, {
          method: 'POST',
          headers: { 'X-CSRFToken': csrftoken },
        })
          .then(function (r) { return r.json(); })
          .then(function () {
            clear();
            if (onRemoved) onRemoved();
          })
          .catch(function () { removeBtn.disabled = false; });
      });
      container.appendChild(removeBtn);
    }

    return { show: show, clear: clear };
  }

  // Dessine les zones sur le canvas Konva et renvoie une petite API pour que
  // initAssociationPanel() puisse réagir aux clics et recolorer les zones.
  function initCanvas() {
    const container = document.getElementById('np-canvas');
    if (!container || typeof Konva === 'undefined') return null;

    const dataEl = document.getElementById('np-zones-data');
    const zones = dataEl ? JSON.parse(dataEl.textContent) : [];
    if (!zones.length) return null;

    const width = parseInt(container.dataset.width, 10) || 1200;
    const height = parseInt(container.dataset.height, 10) || 800;
    const mmPerPx = parseFloat(container.dataset.mmPerPx) || 1;
    const updateUrlTemplate = container.dataset.updateUrlTemplate;
    const removeUrlTemplate = container.dataset.removeUrlTemplate;

    const size = getResponsiveStageSize(container, width, height);
    container.style.height = size.height + 'px';
    const stage = new Konva.Stage({
      container: 'np-canvas',
      width: size.width,
      height: size.height,
      scaleX: size.scale,
      scaleY: size.scale,
      pixelRatio: window.devicePixelRatio || 1,
    });
    attachWheelZoom(stage, function () { return objectGroups; });
    // Adapte la taille des étiquettes de zone au zoom courant : objectif BASE_ZONE_LABEL_PX
    // pixels écran, plafonné à maxFontCanvas pour ne pas déborder de la zone.
    stage.on('wheel', function () {
      const scale = stage.scaleX();
      const sw = ZONE_STROKE_SCREEN_PX / scale;
      zoneStrokeLines.forEach(function (l) { l.strokeWidth(sw); });
      Object.keys(labels).forEach(function (num) {
        const lbl = labels[num];
        if (!lbl) return;
        lbl.fontSize(Math.min(lbl.getAttr('maxFontCanvas'), BASE_ZONE_LABEL_PX / scale));
        lbl.offsetY(lbl.height() / 2);
      });
      // stage.batchDraw() déjà planifié par attachWheelZoom — pas de draw supplémentaire.
    });
    attachPanning(stage);
    const layer = new Konva.Layer();
    stage.add(layer);

    const objectsLayer = new Konva.Layer();
    stage.add(objectsLayer);
    const objectGroups = {}; // placed object id -> Konva.Group
    let onObjectSelect = null; // callback(group) défini par initPlacedObjectsUI

    const zoneByNumber = {};
    zones.forEach(function (z) { zoneByNumber[z.number] = z; });
    function zonePolygon(zoneNumber) {
      const z = zoneByNumber[zoneNumber];
      return z ? z.polygon : null;
    }

    const getScale = function () { return stage.scaleX(); };

    const trySnap = makeTrySnap(
      function (group) { return zonePolygon(group.placedData.zone_number); }, 0, 0, getScale,
      null,
      function (group) { return holesOf[group.placedData.zone_number] || []; }
    );
    const trySnapOutside = makeTrySnapOutside(function (group) { return zonePolygon(group.placedData.zone_number); }, 0, 0, getScale);

    function addObjectGroup(obj) {
      // stage.scaleX() (zoom courant), pas size.scale (échelle d'ajustement initiale
      // figée) : un objet placé après un zoom à la molette doit naître à la bonne taille
      // d'écran immédiatement, sans attendre le prochain cran de zoom.
      const getZoneHoles = function () { return holesOf[obj.zone_number] || []; };
      const group = buildPlacedGroup(obj, mmPerPx, 0, 0, true, stage.scaleX());
      group.dragBoundFunc(makeDragBoundFunc(group, function () { return zonePolygon(obj.zone_number); }, getScale, getZoneHoles));
      const magnet = attachWallMagnet(group, function () { return zonePolygon(obj.zone_number); }, getScale, null, getZoneHoles);
      group.on('click tap', function () {
        if (onObjectSelect) onObjectSelect(group);
      });
      group.on('dragend', function () {
        magnet.finalize();
        obj.x = group.x();
        obj.y = group.y();
        // Hors des murs : la rotation peut avoir changé pendant le glissé (en suivant le
        // périmètre autour d'un coin) — toujours inclure rotation pour rester à jour, sans
        // condition particulière puisqu'un objet "à l'intérieur" ne la modifie de toute
        // façon jamais pendant un simple glissé.
        persistPlacedObject(urlFor(updateUrlTemplate, obj.id), obj, { rotation: obj.rotation });
      });
      attachRightClickRotate(group, function () { return zonePolygon(obj.zone_number); }, function () {
        obj.rotation = group.shapeNode.rotation();
        persistPlacedObject(urlFor(updateUrlTemplate, obj.id), obj, { rotation: obj.rotation });
        if (onObjectSelect) onObjectSelect(group);
      });
      objectsLayer.add(group);
      objectGroups[obj.id] = group;
      objectsLayer.draw();
      return group;
    }

    const lines = {}; // zone number -> Konva.Line
    const labels = {}; // zone number -> Konva.Text (numéro de zone, ou nom du local une fois associé)
    const zoneStrokeLines = []; // toutes les Konva.Line de contour de zone, pour mise à jour du strokeWidth au zoom
    let selectedNumber = null;
    let onSelect = null; // callback(zone|null) défini par initAssociationPanel

    function bboxOf(polygon) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      polygon.forEach(function (p) {
        if (p[0] < minX) minX = p[0];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[1] > maxY) maxY = p[1];
      });
      return { minX: minX, maxX: maxX, minY: minY, maxY: maxY,
               width: maxX - minX, height: maxY - minY };
    }

    // Centroïde géométrique (formule de Gauss/shoelace) — pondéré par les aires des
    // triangles, pas simple moyenne des sommets. Reste à l'intérieur pour les polygones
    // convexes et quasiment toujours dedans pour les L/U qu'on rencontre en pratique.
    function areaCentroid(polygon) {
      let area = 0, cx = 0, cy = 0;
      const n = polygon.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const cross = polygon[i][0] * polygon[j][1] - polygon[j][0] * polygon[i][1];
        area += cross;
        cx += (polygon[i][0] + polygon[j][0]) * cross;
        cy += (polygon[i][1] + polygon[j][1]) * cross;
      }
      area /= 2;
      if (Math.abs(area) < 1e-9) {
        const ax = polygon.reduce(function (s, p) { return s + p[0]; }, 0) / n;
        const ay = polygon.reduce(function (s, p) { return s + p[1]; }, 0) / n;
        return [ax, ay];
      }
      return [cx / (6 * area), cy / (6 * area)];
    }

    function colorFor(zone) {
      if (zone.number === selectedNumber) return COLORS.selected;
      return zone.location_id ? COLORS.associated : COLORS.default;
    }

    function repaint() {
      zones.forEach(function (zone) {
        const c = colorFor(zone);
        const line = lines[zone.number];
        line.stroke(c.stroke);
        line.fill(c.fill);
        const label = labels[zone.number];
        if (label) {
          label.text(zone.location_name || String(zone.number));
        }
      });
      layer.draw();
    }

    // Trier les zones de la plus grande à la plus petite : zones externes en premier (z bas),
    // zones internes en dernier (z haut) — indispensable pour que le hit canvas donne la priorité
    // à la zone interne lors d'un clic dans son aire (couleur peinte après = gagne).
    zones.sort(function (a, b) {
      return Math.abs(polygonSignedArea(b.polygon)) - Math.abs(polygonSignedArea(a.polygon));
    });

    // Parent direct de chaque zone = plus petite zone contenant son centroïde.
    // Seuls les enfants directs forment des trous dans leur zone parente (enfants profonds
    // exclus : ils seront gérés comme trous de leur propre parent direct).
    const centroidOf = {};
    zones.forEach(function (z) { centroidOf[z.number] = areaCentroid(z.polygon); });

    const holesOf = {};
    zones.forEach(function (inner) {
      const [icx, icy] = centroidOf[inner.number];
      let minArea = Infinity, parentNum = null;
      zones.forEach(function (outer) {
        if (outer.number === inner.number) return;
        const oa = Math.abs(polygonSignedArea(outer.polygon));
        if (oa >= minArea) return;
        if (pointInPolygon(icx, icy, outer.polygon)) { minArea = oa; parentNum = outer.number; }
      });
      if (parentNum !== null) {
        if (!holesOf[parentNum]) holesOf[parentNum] = [];
        holesOf[parentNum].push(inner.polygon);
      }
    });

    zones.forEach(function (zone) {
      const holes = holesOf[zone.number] || [];
      let zoneShape, clickTargets;

      if (holes.length === 0) {
        // Zone simple : un seul Konva.Line gère le visuel et le hit canvas.
        const pts = [];
        zone.polygon.forEach(function (p) { pts.push(p[0], p[1]); });
        const line = new Konva.Line({ points: pts, closed: true, strokeWidth: ZONE_STROKE_SCREEN_PX / size.scale });
        layer.add(line);
        zoneShape = line;
        zoneStrokeLines.push(line);
        clickTargets = [line];
      } else {
        // Zone externe avec zones imbriquées — trois shapes :
        // • fillPath (Konva.Path, evenodd, listening:false) : rendu visuel avec trous propres
        //   sans seam ; absent du hit canvas (listening:false).
        // • hitLine (Konva.Line, fill transparent) : couvre l'aire entière dans le hit canvas ;
        //   les zones internes ajoutées après (z plus haut) écrasent sa couleur de hit dans leurs
        //   aires → clic dans une zone interne sélectionne la zone interne, pas cette zone.
        // • strokeLine (Konva.Line, fill vide) : contour visible + hit sur la bordure seulement.
        const fillPath = new Konva.Path({
          data: buildZoneSvgPath(zone.polygon, holes),
          strokeWidth: 0,
          fillRule: 'evenodd',
          listening: false,
        });
        const outerPts = [];
        zone.polygon.forEach(function (p) { outerPts.push(p[0], p[1]); });
        const hitLine = new Konva.Line({
          points: outerPts, closed: true,
          fill: 'rgba(0,0,0,0)', strokeWidth: 0,
        });
        const strokeLine = new Konva.Line({
          points: outerPts.slice(), closed: true,
          fill: '', strokeWidth: ZONE_STROKE_SCREEN_PX / size.scale,
        });
        layer.add(fillPath);
        layer.add(hitLine);
        layer.add(strokeLine);
        zoneStrokeLines.push(strokeLine);
        zoneShape = {
          fill:   function (v) { fillPath.fill(v); },
          stroke: function (v) { strokeLine.stroke(v); },
        };
        clickTargets = [hitLine, strokeLine];
      }

      lines[zone.number] = zoneShape;

      const bbox = bboxOf(zone.polygon);
      const zoneDim = Math.min(bbox.width, bbox.height);
      let labelW = zoneDim * 0.85;
      // Centroïde géométrique, avec replis successifs si le point tombe hors du polygone
      // (arrive pour les L, les U, les zones avec encoches).
      let [lcx, lcy] = areaCentroid(zone.polygon);
      if (!pointInPolygon(lcx, lcy, zone.polygon)) {
        // Fallback 1 : moyenne des sommets
        let vx = 0, vy = 0;
        zone.polygon.forEach(function (p) { vx += p[0]; vy += p[1]; });
        lcx = vx / zone.polygon.length;
        lcy = vy / zone.polygon.length;
      }
      if (!pointInPolygon(lcx, lcy, zone.polygon)) {
        // Fallback 2 : grille 6×6 dans la bbox (les milieux d'arêtes sont sur la frontière,
        // rejetés par les inégalités strictes de pointInPolygon — d'où le passage à une grille
        // avec des points strictement à l'intérieur de la bbox, pas sur son bord).
        const FGRID = 6;
        let f2found = false;
        for (let gy = 1; gy <= FGRID && !f2found; gy++) {
          for (let gx = 1; gx <= FGRID && !f2found; gx++) {
            const tx = bbox.minX + bbox.width * gx / (FGRID + 1);
            const ty = bbox.minY + bbox.height * gy / (FGRID + 1);
            if (pointInPolygon(tx, ty, zone.polygon)) { lcx = tx; lcy = ty; f2found = true; }
          }
        }
      }
      // Pour une zone externe (avec trous), le centroïde peut tomber dans une zone interne
      // qui se dessine par-dessus. Chercher un point dans le couloir (dans le polygone externe,
      // hors de tous les trous) par grille 9×9.
      if (holes.length > 0 && holes.some(function (h) { return pointInPolygon(lcx, lcy, h); })) {
        let found = false;
        const GRID = 9;
        for (let gy = 1; gy < GRID && !found; gy++) {
          for (let gx = 1; gx < GRID && !found; gx++) {
            const tx = bbox.minX + bbox.width * gx / GRID;
            const ty = bbox.minY + bbox.height * gy / GRID;
            if (pointInPolygon(tx, ty, zone.polygon) &&
                !holes.some(function (h) { return pointInPolygon(tx, ty, h); })) {
              lcx = tx; lcy = ty; found = true;
            }
          }
        }
      }
      // Scan vertical : recentrer lcy dans la plage réellement disponible à lcx.
      // Sans ça, un centroïde proche du bord supérieur de la zone fait déborder le label au-dessus
      // du périmètre (la moitié haute du label sort de la zone).
      {
        const stepY = Math.max(0.5, bbox.height / 80);
        let topY = lcy, bottomY = lcy;
        for (let ty = lcy - stepY; ty >= bbox.minY; ty -= stepY) {
          if (!pointInPolygon(lcx, ty, zone.polygon) ||
              holes.some(function (h) { return pointInPolygon(lcx, ty, h); })) break;
          topY = ty;
        }
        for (let ty = lcy + stepY; ty <= bbox.maxY; ty += stepY) {
          if (!pointInPolygon(lcx, ty, zone.polygon) ||
              holes.some(function (h) { return pointInPolygon(lcx, ty, h); })) break;
          bottomY = ty;
        }
        if (bottomY > topY) lcy = (topY + bottomY) / 2;
      }
      // Limiter labelW à l'espace horizontal réellement disponible autour de (lcx, lcy) :
      // sans ça, pour une zone externe avec un couloir étroit, le texte déborde hors du périmètre
      // même si le centre du label est correctement positionné dans le couloir.
      {
        const stepX = Math.max(0.5, bbox.width / 80);
        let leftX = lcx, rightX = lcx;
        for (let tx = lcx - stepX; tx >= bbox.minX; tx -= stepX) {
          if (!pointInPolygon(tx, lcy, zone.polygon) ||
              holes.some(function (h) { return pointInPolygon(tx, lcy, h); })) break;
          leftX = tx;
        }
        for (let tx = lcx + stepX; tx <= bbox.maxX; tx += stepX) {
          if (!pointInPolygon(tx, lcy, zone.polygon) ||
              holes.some(function (h) { return pointInPolygon(tx, lcy, h); })) break;
          rightX = tx;
        }
        lcx = (leftX + rightX) / 2;
        const availW = (rightX - leftX) * 0.8;
        if (availW > 0 && availW < labelW) labelW = availW;
      }
      // maxFontCanvas calculé après le scan de couloir pour inclure le cap labelW/4 ;
      // stocké sur le label pour être réutilisé par le wheel handler (zoom adaptatif).
      const maxFontCanvas = Math.max(4, Math.min(20, zoneDim * 0.18, labelW / 4));
      const label = new Konva.Text({
        x: lcx,
        y: lcy,
        text: zone.location_name || String(zone.number),
        fontSize: Math.min(maxFontCanvas, BASE_ZONE_LABEL_PX / size.scale),
        fontStyle: 'bold',
        fill: '#1a1a1a',
        listening: false,
        width: labelW,
        wrap: 'none',
        ellipsis: true,
      });
      label.setAttr('maxFontCanvas', maxFontCanvas);
      label.offsetX(labelW / 2);
      label.offsetY(label.height() / 2);
      labels[zone.number] = label;
      layer.add(label);

      clickTargets.forEach(function (target) {
        target.on('click', function () {
          selectedNumber = selectedNumber === zone.number ? null : zone.number;
          repaint();
          if (onSelect) onSelect(selectedNumber === null ? null : zone);
        });
      });

      (zone.objects || []).forEach(function (obj) { addObjectGroup(obj); });
    });

    repaint();

    return {
      zones: zones,
      mmPerPx: mmPerPx,
      updateUrlTemplate: updateUrlTemplate,
      removeUrlTemplate: removeUrlTemplate,
      urlFor: urlFor,
      setAssociated: function (zoneNumber, locationId, locationName) {
        const zone = zones.find(function (z) { return z.number === zoneNumber; });
        if (zone) {
          zone.location_id = locationId || null;
          zone.location_name = locationId ? (locationName || null) : null;
        }
        repaint();
      },
      onZoneSelected: function (callback) { onSelect = callback; },
      onObjectSelected: function (callback) { onObjectSelect = callback; },
      addPlacedObject: function (obj) { return addObjectGroup(obj); },
      removePlacedObject: function (id) {
        const group = objectGroups[id];
        if (group) { group.destroy(); delete objectGroups[id]; objectsLayer.draw(); }
      },
      // Le serveur retire les devices/racks posés dans une zone qui vient d'être déliée
      // d'un local (cf. plan_save_associations) : on reflète ça immédiatement dans
      // le canvas, sans recharger la page.
      removePlacedObjectsForZone: function (zoneNumber) {
        Object.keys(objectGroups).forEach(function (id) {
          const group = objectGroups[id];
          if (group.placedData.zone_number === zoneNumber) {
            group.destroy();
            delete objectGroups[id];
          }
        });
        objectsLayer.draw();
      },
      trySnap: trySnap,
      trySnapOutside: trySnapOutside,
      getScale: function () { return stage.scaleX(); },
    };
  }

  function initAssociationPanel(canvas) {
    const panel = document.getElementById('np-association-panel');
    const saveBtn = document.getElementById('np-save-associations-btn');
    if (!panel || !canvas) return;

    const locationsApiUrl = panel.dataset.locationsApiUrl;
    const saveUrl = panel.dataset.saveUrl;
    const csrftoken = getCsrfToken();
    const feedback = document.getElementById('np-save-feedback');

    let locationsCache = null;

    function fetchLocations() {
      if (locationsCache) return Promise.resolve(locationsCache);
      return fetch(locationsApiUrl, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.json(); })
        .then(function (data) {
          locationsCache = data.locations || [];
          return locationsCache;
        });
    }

    function renderPanel(zone, locations) {
      const usedIds = new Set(
        canvas.zones
          .filter(function (z) { return z.number !== zone.number && z.location_id; })
          .map(function (z) { return z.location_id; })
      );

      panel.innerHTML = '';

      const title = document.createElement('p');
      title.innerHTML = `<strong>${interpolate(gettext('Zone %(number)s sélectionnée'), { number: zone.number }, true)}</strong>`;
      panel.appendChild(title);

      const select = document.createElement('select');
      select.className = 'form-select mb-2';

      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = gettext('— Aucun local —');
      select.appendChild(noneOption);

      locations.forEach(function (loc) {
        if (usedIds.has(loc.id)) return;
        const option = document.createElement('option');
        option.value = loc.id;
        option.textContent = loc.name;
        if (loc.id === zone.location_id) option.selected = true;
        select.appendChild(option);
      });
      panel.appendChild(select);

      const assocBtn = document.createElement('button');
      assocBtn.type = 'button';
      assocBtn.className = 'btn btn-outline-primary';
      assocBtn.textContent = interpolate(gettext('Associer à la zone %(number)s'), { number: zone.number }, true);
      assocBtn.addEventListener('click', function () {
        const locationId = select.value ? parseInt(select.value, 10) : null;
        const isUnlinking = !!zone.location_id && !locationId;
        if (isUnlinking) {
          const confirmMessage = interpolate(
            gettext(
              "Voulez-vous vraiment délier le local « %(location_name)s » de la zone %(number)s ? " +
              "Une fois enregistré, l'onglet \"Plan\" disparaîtra de la page de ce local, le numéro de zone " +
              "réapparaîtra sur le plan à la place de son nom, et les devices/racks posés dans cette zone " +
              "en seront retirés (ils resteront dans leur local NetBox, mais ne seront plus placés sur le plan)."
            ),
            { location_name: zone.location_name || '', number: zone.number },
            true
          );
          const ok = window.confirm(confirmMessage);
          if (!ok) return;
        }
        const selectedOption = select.options[select.selectedIndex];
        const locationName = locationId ? selectedOption.textContent : null;
        canvas.setAssociated(zone.number, locationId, locationName);
        if (feedback) feedback.textContent = '';
      });
      panel.appendChild(assocBtn);
    }

    canvas.onZoneSelected(function (zone) {
      if (!zone) {
        panel.innerHTML = `<p class="text-muted mb-0">${gettext("Cliquez sur une zone du plan pour l'associer à un local.")}</p>`;
        return;
      }
      panel.innerHTML = `<p class="text-muted mb-0">${gettext('Chargement des locaux…')}</p>`;
      fetchLocations()
        .then(function (locations) { renderPanel(zone, locations); })
        .catch(function () {
          panel.innerHTML = `<p class="text-danger mb-0">${gettext('Erreur lors du chargement des locaux.')}</p>`;
        });
    });

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        saveBtn.disabled = true;
        if (feedback) feedback.textContent = '';
        const associations = canvas.zones.map(function (z) {
          return { zone_number: z.number, location_id: z.location_id || null };
        });
        fetch(saveUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRFToken': csrftoken },
          body: JSON.stringify({ associations: associations }),
        })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            saveBtn.disabled = false;
            // Toute zone enregistrée sans local (délier) voit ses devices/racks retirés
            // côté serveur (cf. plan_save_associations) ; on l'applique aussi ici
            // pour ne pas laisser leurs marqueurs affichés jusqu'au prochain rechargement.
            associations.forEach(function (a) {
              if (!a.location_id) canvas.removePlacedObjectsForZone(a.zone_number);
            });
            if (!feedback) return;
            if (data.errors && data.errors.length) {
              feedback.innerHTML = `<span class="text-danger">${data.errors.join('<br>')}</span>`;
            } else {
              const savedMessage = interpolate(gettext('%(saved)s association(s) enregistrée(s).'), { saved: data.saved }, true);
              feedback.innerHTML = `<span class="text-success">${savedMessage}</span>`;
            }
          })
          .catch(function () {
            saveBtn.disabled = false;
            if (feedback) feedback.innerHTML = `<span class="text-danger">${gettext("Erreur réseau lors de l'enregistrement.")}</span>`;
          });
      });
    }
  }

  // Vue du plan : relie le panneau "Objets à placer" et le panneau "Propriétés" au
  // canvas déjà construit par initCanvas(). Chaque item plaçable porte un zone_number
  // (voir plan_pickable_objects côté serveur) qu'on résout en zone_pk via canvas.zones.
  function initPlacedObjectsUI(canvas) {
    const pickableContainer = document.getElementById('np-pickable-panel');
    const propertiesContainer = document.getElementById('np-properties-panel');
    if (!canvas || !pickableContainer) return;

    const properties = initPropertiesPanel(propertiesContainer);

    function resolvePlaceUrl(item) {
      const zone = canvas.zones.find(function (z) { return z.number === item.zone_number; });
      const template = pickableContainer.dataset.placeUrlTemplate;
      // Le template de place_object est construit sur un pk de zone factice (voir
      // plan.html/plan_tab.html) ; on le remplace par le pk réel de la zone cible.
      return zone ? template.replace('999999', zone.pk) : null;
    }

    const pickable = initPickablePanel(pickableContainer, pickableContainer.dataset.pickableUrl, resolvePlaceUrl, function (obj) {
      canvas.addPlacedObject(obj);
    });

    canvas.onObjectSelected(function (group) {
      properties.show(group, {
        update: canvas.urlFor(canvas.updateUrlTemplate, group.placedData.id),
        remove: canvas.urlFor(canvas.removeUrlTemplate, group.placedData.id),
      }, function (updatedObj) {
        Object.assign(group.placedData, updatedObj);
        group.shapeNode.rotation(updatedObj.rotation || 0);
        group.labelNode.text(updatedObj.name || '');
        positionLabel(group.labelNode, group.shapeNode, updatedObj.name_position || 'center', canvas.getScale());
        group.getLayer().draw();
      }, function () {
        canvas.removePlacedObject(group.placedData.id);
        if (pickable) pickable.refresh();
      }, function () {
        canvas.trySnap(group);
      }, function () {
        canvas.trySnapOutside(group);
      });
    });
  }

  // Vue d'un local (onglet "Plan" d'une Location) : canvas autonome affichant une
  // seule zone, recentrée sur une origine locale (même décalage que extract_zone_svg()
  // côté serveur). Les coordonnées des objets placés sont déjà exprimées dans l'espace
  // global du plan (PlacedObject.x/y) ; on les décale ici par offsetX/offsetY pour
  // les afficher dans ce repère local — c'est la même ligne en base que la vue du plan,
  // simplement projetée différemment, ce qui assure la synchronisation entre les deux vues.
  function initLocationCanvas() {
    const container = document.getElementById('np-loc-canvas');
    if (!container || typeof Konva === 'undefined') return;

    // Onglet masqué (display:none) → clientWidth=0 → getFillStageSize retomberait sur
    // scale=1 (taille données brutes) au lieu de la taille réelle de la carte Bootstrap.
    // On sort ici ; shown.bs.tab (enregistré dans DOMContentLoaded) rappellera cette
    // fonction une fois le tab complètement visible et clientWidth correct.
    if (container.clientWidth === 0) return;

    // Guard : évite une double-initialisation si shown.bs.tab se déclenche plusieurs fois.
    if (container.dataset.locInit) return;
    container.dataset.locInit = '1';

    const polygonEl = document.getElementById('np-loc-polygon-data');
    const objectsEl = document.getElementById('np-loc-objects-data');
    const polygon = polygonEl ? JSON.parse(polygonEl.textContent) : null;
    const objects = objectsEl ? JSON.parse(objectsEl.textContent) : [];
    if (!polygon) return;

    const width = parseInt(container.dataset.width, 10) || 400;
    const height = parseInt(container.dataset.height, 10) || 400;
    const offsetX = parseFloat(container.dataset.offsetX) || 0;
    const offsetY = parseFloat(container.dataset.offsetY) || 0;
    const mmPerPx = parseFloat(container.dataset.mmPerPx) || 1;
    const updateUrlTemplate = container.dataset.updateUrlTemplate;
    const removeUrlTemplate = container.dataset.removeUrlTemplate;

    const size = getFillStageSize(container, width, height, 700);
    container.style.height = size.height + 'px';
    const stage = new Konva.Stage({
      container: 'np-loc-canvas',
      width: size.width,
      height: size.height,
      scaleX: size.scale,
      scaleY: size.scale,
      pixelRatio: window.devicePixelRatio || 1,
    });
    attachWheelZoom(stage, function () { return objectGroups; });
    attachPanning(stage);
    const layer = new Konva.Layer();
    stage.add(layer);

    const innerPolygonsEl = document.getElementById('np-loc-inner-polygons');
    const innerPolygonsRaw = innerPolygonsEl ? JSON.parse(innerPolygonsEl.textContent) : [];
    const localPolygon = polygon.map(function (p) { return [p[0] - offsetX, p[1] - offsetY]; });
    const localInnerPolygons = innerPolygonsRaw.map(function (poly) {
      return poly.map(function (p) { return [p[0] - offsetX, p[1] - offsetY]; });
    });

    const strokeLines = [];
    if (localInnerPolygons.length > 0) {
      // Zone externe avec sous-zones : fillPath (evenodd) pour les trous visuels + strokeLine
      // pour le contour extérieur. Le fill est absent de strokeLine pour ne pas recouvrir les trous.
      const fillPath = new Konva.Path({
        data: buildZoneSvgPath(localPolygon, localInnerPolygons),
        fill: COLORS.associated.fill,
        strokeWidth: 0,
        fillRule: 'evenodd',
        listening: false,
      });
      layer.add(fillPath);
      const outerPts = [];
      localPolygon.forEach(function (p) { outerPts.push(p[0], p[1]); });
      const outerStroke = new Konva.Line({
        points: outerPts, closed: true,
        stroke: COLORS.associated.stroke, fill: '',
        strokeWidth: ZONE_STROKE_SCREEN_PX / size.scale,
        listening: false,
      });
      layer.add(outerStroke);
      strokeLines.push(outerStroke);
      // Contours des zones internes : dessine les murs des pièces et matérialise
      // les limites de placement (les objets ne peuvent pas être posés dans ces aires).
      localInnerPolygons.forEach(function (innerPoly) {
        const innerPts = [];
        innerPoly.forEach(function (p) { innerPts.push(p[0], p[1]); });
        const innerStroke = new Konva.Line({
          points: innerPts, closed: true,
          stroke: COLORS.associated.stroke, fill: '',
          strokeWidth: ZONE_STROKE_SCREEN_PX / size.scale,
          listening: false,
        });
        layer.add(innerStroke);
        strokeLines.push(innerStroke);
      });
    } else {
      const pts = [];
      localPolygon.forEach(function (p) { pts.push(p[0], p[1]); });
      const line = new Konva.Line({
        points: pts, closed: true,
        strokeWidth: ZONE_STROKE_SCREEN_PX / size.scale,
        stroke: COLORS.associated.stroke, fill: COLORS.associated.fill,
        listening: false,
      });
      layer.add(line);
      strokeLines.push(line);
    }
    stage.on('wheel', function () {
      const sw = ZONE_STROKE_SCREEN_PX / stage.scaleX();
      strokeLines.forEach(function (l) { l.strokeWidth(sw); });
      layer.batchDraw();
    });

    const objectsLayer = new Konva.Layer();
    stage.add(objectsLayer);
    const objectGroups = {};
    let onObjectSelect = null;
    const getScale = function () { return stage.scaleX(); };
    const getLocalPolygon = function () { return localPolygon; };

    // Snap targets : bords des zones internes (pour l'aimantation — surfaces de mur réelles).
    const getLocalInnerPolygons = localInnerPolygons.length > 0
      ? function () { return localInnerPolygons; }
      : null;

    // Exclusion : zones internes (objets ne peuvent pas être placés à l'intérieur des pièces).
    const getLocalExclusionPolygons = localInnerPolygons.length > 0
      ? function () { return localInnerPolygons; }
      : null;

    const trySnap = makeTrySnap(getLocalPolygon, offsetX, offsetY, getScale, getLocalInnerPolygons, getLocalExclusionPolygons);
    const trySnapOutside = makeTrySnapOutside(getLocalPolygon, offsetX, offsetY, getScale);

    function addObjectGroup(obj) {
      const group = buildPlacedGroup(obj, mmPerPx, offsetX, offsetY, true, stage.scaleX());
      group.dragBoundFunc(makeDragBoundFunc(group, getLocalPolygon, getScale, getLocalExclusionPolygons));
      const magnet = attachWallMagnet(group, getLocalPolygon, getScale, getLocalInnerPolygons, getLocalExclusionPolygons);
      group.on('click tap', function () {
        if (onObjectSelect) onObjectSelect(group);
      });
      group.on('dragend', function () {
        magnet.finalize();
        obj.x = group.x() + offsetX;
        obj.y = group.y() + offsetY;
        persistPlacedObject(urlFor(updateUrlTemplate, obj.id), obj, { rotation: obj.rotation });
      });
      attachRightClickRotate(group, getLocalPolygon, function () {
        obj.rotation = group.shapeNode.rotation();
        persistPlacedObject(urlFor(updateUrlTemplate, obj.id), obj, { rotation: obj.rotation });
        if (onObjectSelect) onObjectSelect(group);
      });
      objectsLayer.add(group);
      objectGroups[obj.id] = group;
      objectsLayer.draw();
      return group;
    }

    objects.forEach(function (obj) { addObjectGroup(obj); });

    const canvasApi = {
      mmPerPx: mmPerPx,
      updateUrlTemplate: updateUrlTemplate,
      removeUrlTemplate: removeUrlTemplate,
      urlFor: urlFor,
      onObjectSelected: function (callback) { onObjectSelect = callback; },
      addPlacedObject: function (obj) { return addObjectGroup(obj); },
      removePlacedObject: function (id) {
        const group = objectGroups[id];
        if (group) { group.destroy(); delete objectGroups[id]; objectsLayer.draw(); }
      },
      trySnap: trySnap,
      trySnapOutside: trySnapOutside,
    };

    const pickableContainer = document.getElementById('np-pickable-panel');
    const propertiesContainer = document.getElementById('np-properties-panel');
    let pickable = null;
    if (pickableContainer) {
      pickable = initPickablePanel(
        pickableContainer,
        pickableContainer.dataset.pickableUrl,
        function () { return pickableContainer.dataset.placeUrl; },
        function (obj) { canvasApi.addPlacedObject(obj); }
      );
    }
    if (propertiesContainer) {
      const properties = initPropertiesPanel(propertiesContainer);
      canvasApi.onObjectSelected(function (group) {
        properties.show(group, {
          update: canvasApi.urlFor(canvasApi.updateUrlTemplate, group.placedData.id),
          remove: canvasApi.urlFor(canvasApi.removeUrlTemplate, group.placedData.id),
        }, function (updatedObj) {
          Object.assign(group.placedData, updatedObj);
          group.shapeNode.rotation(updatedObj.rotation || 0);
          group.labelNode.text(updatedObj.name || '');
          positionLabel(group.labelNode, group.shapeNode, updatedObj.name_position || 'center', stage.scaleX());
          group.getLayer().draw();
        }, function () {
          canvasApi.removePlacedObject(group.placedData.id);
          if (pickable) pickable.refresh();
        }, function () {
          canvasApi.trySnap(group);
        }, function () {
          canvasApi.trySnapOutside(group);
        });
      });
    }
  }
})();
