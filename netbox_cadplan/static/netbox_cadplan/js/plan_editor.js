(function () {
  const COLORS = {
    default: { stroke: '#2196F3', fill: 'rgba(33,150,243,0.15)' },
    associated: { stroke: '#43a047', fill: 'rgba(67,160,71,0.18)' },
    selected: { stroke: '#f59f00', fill: 'rgba(245,159,0,0.20)' },
  };

  // NetBox toggles light/dark via the data-bs-theme attribute on <html> (without a page
  // reload). Label text (zone number, placed object name) is painted onto a
  // canvas — so it doesn't benefit from NetBox's theme CSS variables — hence this
  // manual light/dark choice to stay readable in both cases.
  const LABEL_FILL_LIGHT = '#1a1a1a';
  const LABEL_FILL_DARK = '#f1f3f5';

  function isDarkTheme() {
    const explicit = document.documentElement.getAttribute('data-bs-theme');
    if (explicit) return explicit === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function labelFillColor() {
    return isDarkTheme() ? LABEL_FILL_DARK : LABEL_FILL_LIGHT;
  }

  // Calls `callback` on every theme toggle (click on NetBox's light/dark selector),
  // so already-drawn labels get recolored without needing to reload the page.
  function onThemeChange(callback) {
    new MutationObserver(callback).observe(document.documentElement, {
      attributes: true, attributeFilter: ['data-bs-theme'],
    });
  }

  function getCsrfToken() {
    // CSRF_COOKIE_HTTPONLY=True in NetBox: the csrftoken cookie isn't readable from JS.
    // NetBox exposes the token via window.CSRF_TOKEN (see templates/base/base.html).
    return window.CSRF_TOKEN;
  }

  // The plan is normalized server-side into a logical dataWidth x dataHeight space
  // (Plan.width_px / height_px), but the Bootstrap card containing the canvas
  // can be much narrower depending on screen resolution. So we compute a
  // Konva stage size that fits the actual container, and compensate with a
  // Konva scale: zone coordinates (logical space) remain unchanged.
  function getResponsiveStageSize(container, dataWidth, dataHeight) {
    const containerWidth = container.clientWidth || dataWidth;
    const scale = containerWidth > 0 ? Math.min(1, containerWidth / dataWidth) : 1;
    return {
      width: Math.round(dataWidth * scale),
      height: Math.round(dataHeight * scale),
      scale: scale,
    };
  }

  // Like getResponsiveStageSize(), but also enlarges the plan to fill the width
  // of the container (not just shrink it). Used for a room's view: the bounding
  // box of a single zone (a few hundred logical px) is almost always much
  // smaller than the Bootstrap card containing it, otherwise the plan stays tiny in
  // a large empty card. `maxHeight` caps the final height to avoid disproportionate
  // enlargement for a very narrow/tall room.
  function getFillStageSize(container, dataWidth, dataHeight, maxHeight) {
    const containerWidth = container.clientWidth || dataWidth;
    // Always fill the container's width: the Bootstrap card can be much
    // wider than the zone's bounding box, especially for portrait zones.
    const scale = containerWidth > 0 ? containerWidth / dataWidth : 1;
    // Height is proportional; if it exceeds maxHeight, we cap the stage
    // but keep the wide scale (the bottom part stays accessible via panning).
    const fullHeight = Math.round(dataHeight * scale);
    const stageHeight = maxHeight ? Math.min(fullHeight, maxHeight) : fullHeight;
    return {
      width: Math.round(containerWidth),
      height: stageHeight,
      scale: scale,
    };
  }

  // "General view" for a room's Zone tab: unlike getFillStageSize
  // (which only fills the width, cropping the bottom of a tall, narrow room
  // beyond maxHeight), here the scale is bounded by both the width AND
  // maxHeight, so the whole room always fits in the canvas without
  // panning. marginRatio then slightly shrinks this scale (visual margin around
  // the room) and the stage is repositioned (x/y) to center the room in the space
  // thus freed up, on both axes.
  function getFitStageSize(container, dataWidth, dataHeight, maxHeight, marginRatio) {
    const containerWidth = container.clientWidth || dataWidth;
    const rawScale = dataWidth > 0 && dataHeight > 0
      ? Math.min(containerWidth / dataWidth, maxHeight / dataHeight)
      : 1;
    const scale = rawScale * (1 - marginRatio);
    const stageWidth = Math.round(containerWidth);
    const stageHeight = Math.round(dataHeight * rawScale);
    return {
      width: stageWidth,
      height: stageHeight,
      scale: scale,
      x: (stageWidth - dataWidth * scale) / 2,
      y: (stageHeight - dataHeight * scale) / 2,
    };
  }

  // Cursor-centered wheel zoom (standard Konva recipe): adjusts the stage's
  // scale in multiplicative steps, and compensates the position so the point under the
  // cursor stays fixed on screen during the zoom.
  const WHEEL_ZOOM_FACTOR = 1.08;
  // Logical coordinates (Plan.width_px/height_px, or a zone's bounding box)
  // have no common absolute scale from one plan to another — a scale of "1" doesn't mean
  // anything on its own. Absolute bounds (e.g. min 0.05 / max 20) would therefore cut
  // zoom short prematurely as soon as a plan started out already close to one of them (e.g. a small
  // zone whose initial fit scale is already 4). We instead bound zoom as a
  // factor relative to THIS canvas's starting scale, to guarantee the same usable
  // zoom range everywhere.
  const WHEEL_ZOOM_RANGE = 50;

  // `getGroups` (optional) returns the {id -> Konva.Group} dict of placed objects at
  // call time — to rescale their text/border to a constant on-screen size at
  // each zoom step (see rescaleObjectGroups). A getter (rather than the dict directly)
  // because this dict is populated/modified after the call to attachWheelZoom (placement, deletion).
  function attachWheelZoom(stage, getGroups) {
    const baseScale = stage.scaleX() || 1;
    const minScale = baseScale / WHEEL_ZOOM_RANGE;
    const maxScale = baseScale * WHEEL_ZOOM_RANGE;
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
      newScale = Math.max(minScale, Math.min(maxScale, newScale));
      stage.scale({ x: newScale, y: newScale });
      stage.position({
        x: pointer.x - mousePointTo.x * newScale,
        y: pointer.y - mousePointTo.y * newScale,
      });
      if (getGroups) rescaleObjectGroups(getGroups(), newScale);
      stage.batchDraw();
    });
  }

  // Panning the plan by holding the left click down on an empty area of the
  // canvas (not on a placed object): the stage itself is made draggable — Konva already
  // routes the mousedown to the deepest node under the cursor, so a click-drag
  // started directly on an object moves that object (its own draggable Group),
  // while a click-drag on the background moves the stage (panning).
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
    // requestAnimationFrame guarantees the first CSS layout is resolved before reading
    // container.clientWidth — without this, Bootstrap hasn't computed column widths
    // yet and clientWidth is 0, which forces getResponsiveStageSize to fall back to
    // dataWidth and creates an oversized stage (blurry / cropped rendering).
    requestAnimationFrame(function () {
      const canvas = initCanvas();
      const pickable = initPlacedObjectsUI(canvas);
      initAssociationPanel(canvas, function () {
        if (pickable) pickable.refresh();
      });
      const centerViewBtn = document.getElementById('np-center-view-btn');
      if (centerViewBtn && canvas) {
        centerViewBtn.addEventListener('click', function () { canvas.centerView(); });
      }
    });
    initLocationCanvas();
    // If the Zone tab isn't active on load (clientWidth=0), retry as soon as
    // Bootstrap displays it — shown.bs.tab fires after the transition completes, so
    // clientWidth is guaranteed correct at that point.
    document.addEventListener('shown.bs.tab', initLocationCanvas);
  });

  function initLayerPanel() {
    const panel = document.getElementById('np-layer-panel');
    if (!panel) return;

    const layersUrl = panel.dataset.layersUrl;
    const confirmUrl = panel.dataset.confirmUrl;
    const confirmPreviewUrl = panel.dataset.confirmPreviewUrl;
    const csrftoken = getCsrfToken();
    // The presence of zones already loaded on the page means this is a re-import (the layer
    // had already been confirmed once before): in that case we go through the summary
    // before applying, rather than silently overwriting existing associations/placed
    // objects. A very first import (no zone yet) stays immediate.
    const isReimport = !!document.getElementById('np-zones-data');

    let selectedLayer = null;

    function renderError(message) {
      panel.innerHTML = `<p class="text-danger mb-0">${message}</p>`;
    }

    const networkErrorConfirm = gettext('Network error while confirming the layer.');

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

    // Displays "X zone(s) unchanged, Y zone(s) removed (Z placed object(s) removed),
    // W new zone(s)" with an explicit "Apply" button — called only for
    // a re-import (see isReimport), never for the very first import.
    function renderConfirmSummary(layerName, summary) {
      panel.innerHTML = '';
      const message = document.createElement('p');
      message.textContent = interpolate(
        gettext(
          '%(unchanged)s zone(s) unchanged, %(removed)s zone(s) removed ' +
          '(%(objects)s placed object(s) will be removed), %(created)s new zone(s).'
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
      applyBtn.textContent = gettext('Apply');
      applyBtn.addEventListener('click', function () { doConfirm(layerName, applyBtn); });
      panel.appendChild(applyBtn);

      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.className = 'btn btn-outline-secondary';
      cancelBtn.textContent = gettext('Cancel');
      cancelBtn.addEventListener('click', function () { window.location.reload(); });
      panel.appendChild(cancelBtn);
    }

    function renderLayers(layers) {
      if (!layers.length) {
        renderError(gettext('No layer found in this DXF file.'));
        return;
      }

      const select = document.createElement('select');
      select.className = 'form-select mb-3';

      const placeholderOption = document.createElement('option');
      placeholderOption.value = '';
      placeholderOption.textContent = gettext('Choose a layer…');
      placeholderOption.disabled = true;
      placeholderOption.selected = true;
      select.appendChild(placeholderOption);

      layers.forEach(function (layer) {
        const option = document.createElement('option');
        option.value = layer;
        option.textContent = layer;
        select.appendChild(option);
      });

      const confirmBtn = document.createElement('button');
      confirmBtn.type = 'button';
      confirmBtn.className = 'btn btn-primary';
      confirmBtn.textContent = gettext('Confirm this layer');
      confirmBtn.disabled = true;

      select.addEventListener('change', function () {
        selectedLayer = select.value || null;
        confirmBtn.disabled = !selectedLayer;
        if (selectedLayer) previewLayer(selectedLayer);
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
      panel.appendChild(select);
      panel.appendChild(confirmBtn);
    }

    panel.innerHTML = `
      <div class="d-flex align-items-center gap-2 text-muted">
        <div class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></div>
        <span>${gettext('Reading layers from the DXF file…')}</span>
      </div>
    `;
    fetch(layersUrl)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) { renderError(data.error); return; }
        renderLayers(data.layers || []);
      })
      .catch(function () { renderError(gettext('Network error while reading layers.')); });
  }

  // Read-only preview of a layer, called on every click on a different
  // layer in the selection panel (before confirmation).
  function previewLayer(layerName) {
    const container = document.getElementById('np-preview-canvas');
    if (!container) return;

    const baseUrl = container.dataset.previewUrl;
    const width = parseInt(container.dataset.width, 10) || 1200;
    const height = parseInt(container.dataset.height, 10) || 800;

    container.innerHTML = `<p class="text-muted p-3 mb-0">${gettext('Loading preview…')}</p>`;

    fetch(`${baseUrl}?layer=${encodeURIComponent(layerName)}`)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.error) {
          container.innerHTML = `<p class="text-danger p-3 mb-0">${data.error}</p>`;
          return;
        }
        const strokes = data.strokes || [];
        if (!strokes.length) {
          container.innerHTML = `<p class="text-muted p-3 mb-0">${gettext('No elements found on this layer.')}</p>`;
          return;
        }
        if (typeof Konva === 'undefined') {
          container.innerHTML = `<p class="text-danger p-3 mb-0">${gettext('Konva.js could not be loaded.')}</p>`;
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
        container.innerHTML = `<p class="text-danger p-3 mb-0">${gettext('Network error while previewing the layer.')}</p>`;
      });
  }

  // --- Rendering of placed objects (Device/Rack): shared between the plan view (initCanvas)
  // and a room's view (initLocationCanvas). ---

  const NAME_POSITIONS = [
    ['top', gettext('Top')], ['bottom', gettext('Bottom')], ['left', gettext('Left')],
    ['right', gettext('Right')], ['center', gettext('Center')],
  ];

  function shapeHalfExtents(shapeNode) {
    if (shapeNode instanceof Konva.Circle) {
      const r = shapeNode.radius();
      return { hw: r, hh: r };
    }
    return { hw: shapeNode.width() / 2, hh: shapeNode.height() / 2 };
  }

  // Point-in-polygon test (ray casting) — needed because a simple bounding
  // box isn't enough for a non-convex zone (offsets/recesses in the wall outline):
  // a point can be inside the bbox without being inside the actual polygon.
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

  // Corners of a rectangle centered on (cx, cy), with half-dimensions hw/hh, rotated by
  // rotationDeg degrees.
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

  // True only if the segments cross "properly" (one actually crosses through
  // the other). A simple touch — an endpoint sitting exactly on the other segment, or
  // an edge-to-edge alignment — doesn't count as a crossing: this is precisely what
  // lets an object placed exactly flush against a wall (its edge then coincides
  // with a polygon segment) remain valid, without letting an actual
  // overlap through.
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

  // Signed area (shoelace formula) — positive if the polygon is defined
  // counterclockwise, negative clockwise. Used to sort by size and to
  // detect nested zones (centroid of a small zone inside a larger one).
  function polygonSignedArea(polygon) {
    let a = 0;
    for (let i = 0, n = polygon.length; i < n; i++) {
      const j = (i + 1) % n;
      a += polygon[i][0] * polygon[j][1] - polygon[j][0] * polygon[i][1];
    }
    return a / 2;
  }

  // Builds the SVG path data of a multi-ring polygon for Konva.Path.
  // Used with fillRule:'evenodd' for visual rendering: interior areas are
  // transparent with no seam artifacts. Kept separate from bridgeHole (hit detection).
  function buildZoneSvgPath(outerPolygon, holePolygons) {
    function ringToPath(ring) {
      return ring.map(function (p, i) {
        return (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1);
      }).join(' ') + ' Z';
    }
    return [outerPolygon].concat(holePolygons).map(ringToPath).join(' ');
  }

  // Visual thickness of the zone outline (in screen pixels). Used everywhere the zone
  // outline is drawn (initCanvas, initLocationCanvas) and to compute the snap
  // clearance: the object snaps to the inner face of the line, not the centerline.
  const ZONE_STROKE_SCREEN_PX = 1.0;

  // Clearance margin (in canvas units) used by isFootprintInsidePolygon and
  // projectOutsidePolygon — contexts without direct access to the current scale. The value 1.5
  // corresponds to roughly half the zone outline thickness at the typical initial scale of a
  // normal-sized plan (≈ 0.3-0.5). For flushPositionForWall, the clearance is recomputed
  // dynamically based on the current scale (ZONE_STROKE_SCREEN_PX / 2 / scale).
  const WALL_CLEARANCE_PX = 1.5;

  function resolvedClearance(getScale) {
    return getScale ? ZONE_STROKE_SCREEN_PX / (2 * getScale()) : WALL_CLEARANCE_PX;
  }

  function dist2(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }

  // Binary search along the from→to segment: returns the valid point closest to `to`.
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

  // Checks that the object's entire FOOTPRINT (not just its center, nor just its
  // corners) stays inside the polygon, with a clearance margin from the wall.
  // Checking only the center — or even just the corners — isn't enough for a
  // non-convex zone (offsets/recesses): the polygon outline can cut between two corners
  // each individually valid, leaving an edge of the object crossing the wall. So we
  // explicitly test that no edge of the rectangle crosses an edge of the polygon.
  function isFootprintInsidePolygon(shape, cx, cy, hw, hh, rotationDeg, polygon, clearance) {
    if (clearance === undefined) clearance = WALL_CLEARANCE_PX;
    // Subtract an epsilon from the clearance for the check: flushPositionForWall places the
    // extended corner exactly on wall.coord, and pointInPolygon uses strict
    // inequalities → a point on the boundary is rejected. The epsilon (0.001 canvas px = ~0.003
    // screen px at scale 3) is invisible but avoids rejecting flush-to-wall positions.
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

  // Counterpart of isFootprintInsidePolygon: returns true if the object's footprint OVERLAPS
  // the polygon (used for exclusion zones — nested zones in the per-room view).
  // Three intersection cases covered:
  //   (A) object center inside the polygon
  //   (B) a footprint corner inside the polygon
  //   (C) a footprint edge crosses a polygon edge
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

  // LOCAL half-width/half-height (before rotation) of the shape — this is what
  // rectCorners()/isFootprintInsidePolygon() expect, since they apply the full
  // rotation themselves. Not to be confused with rectHalfExtents() (already-rotated
  // bounding box, used for positioning against a wall): passing it the result of
  // rectHalfExtents() would rotate the shape twice and yield a wrong footprint
  // for any 90/270° rotation — this was the bug behind the "hitbox doesn't rotate
  // correctly" issue, and later the "snapping doesn't work on vertical walls" issue.
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

  // Computes the position/rotation of an object "permanently stuck to the outside" of
  // its zone's polygon (the "Outside walls" option): projects (x, y) onto the closest
  // point of the perimeter (all segments, whether orthogonal or not — unlike
  // findNearestWall() which only considers horizontal/vertical walls for interior
  // snapping), then offsets that point toward the OUTSIDE of the polygon
  // (the outward-pointing normal, determined by a pointInPolygon test rather than
  // assuming a polygon winding direction) by the object's half-footprint along
  // that normal + a clearance margin. A rectangle's rotation is aligned with
  // the segment's tangent, so its "back" edge sits flush against the wall; this has no
  // effect for a circle. Dragging follows the perimeter naturally, including around
  // corners, since the closest segment changes continuously with (x, y).
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

  // Prevents dragging a placed object outside the bounds of its zone: without this, a
  // slightly too-fast drag pushes the object outside the polygon (or even outside the
  // visible canvas), and it becomes impossible to find/re-select. `getPolygon` returns
  // the zone's polygon, in the same coordinate space as group.x()/y(). Any position
  // whose full footprint (corners included) doesn't stay inside the polygon is rejected.
  //
  // If the requested position is invalid, we don't abruptly snap back to the last
  // validated position (that would "stall" the object as soon as a single drag sample
  // landed on an invalid position, even a fraction of a pixel from a wall: a fast drag
  // could then freeze the object well before the wall, for no visible reason — this was
  // the "invisible collisions" bug near walls). Instead, we binary-search, along the
  // last-valid-position → requested-position segment, for the closest point to the
  // wall that stays valid: the object thus slides up to the wall instead of freezing en route.
  function makeDragBoundFunc(group, getPolygon, getScale, getExclusionPolygons) {
    let lastValidLocal = null;
    return function (pos) {
      const polygon = getPolygon();
      if (!polygon || polygon.length < 3) return pos;

      if (group.placedData.outside_wall) {
        // "Outside walls" option: the object is permanently stuck to the perimeter, there's no
        // notion of an "invalid" position to correct via binary search — the projection is
        // always defined, so it's applied directly on every drag sample.
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
        // First use: current position of the group, assumed to already be valid
        // (loaded from the server, or placed at the zone's center on creation).
        lastValidLocal = { x: group.x(), y: group.y() };
      }

      if (valid(localPos)) {
        lastValidLocal = { x: localPos.x, y: localPos.y };
        return pos;
      }

      // Axial sliding + corner crossing: when pushing diagonally toward a corner,
      // the object should slide along the first wall it reaches, then continue around the
      // corner instead of getting stuck on the diagonal. We compute 5 candidates:
      //   direct  : direct binary search (usual behavior)
      //   slideX  : purely horizontal slide from lastValid → (localPos.x, lastValid.y)
      //   slideY  : purely vertical slide   from lastValid → (lastValid.x, localPos.y)
      //   slideXY : from slideX, vertical slide   → (slideX.x, localPos.y)   [H→V corner]
      //   slideYX : from slideY, horizontal slide → (localPos.x, slideY.y)  [V→H corner]
      // We keep the candidate closest to localPos (= the one that progressed most toward
      // the requested destination).
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

  // Builds a Konva.Group for a serialized PlacedObject (see _serialize_placed_object
  // server-side). `offsetX/offsetY` allow recentering on a zone's local space
  // (room view); leave at 0 for the plan's global space. `stageScale` is the
  // zoom factor applied to the parent Konva.Stage (see getResponsiveStageSize() /
  // getFillStageSize()): without compensation, the name's font size would be multiplied
  // by this zoom (e.g. x5-6 in a room view enlarged to fill the card), so we
  // divide the desired font size by this factor to get text at a constant on-screen
  // size regardless of the zoom level.
  // "On-screen" stroke width and font size (px), constant regardless of the
  // stage's current zoom — see rescaleObjectGroups(), which reapplies these sizes
  // at each wheel zoom step so that text/borders stay readable instead
  // of growing/shrinking with the plan's content.
  const BASE_STROKE_PX = 1;
  const BASE_FONT_PX = 12;
  const BASE_ZONE_LABEL_PX = 12;
  // "Grab" margin added around each shape for click/drag (Konva
  // hitStrokeWidth): a device a few cm wide on a large plan may only measure
  // 2-3px on screen, which makes it nearly impossible to grab precisely with the mouse.
  // This margin doesn't change the visual rendering, only the clickable area.
  const HIT_PADDING_PX = 24;

  // Color/thickness of a placed object's selection highlight. #f59f00 (the same
  // hue as COLORS.selected, used for zones) is nearly indistinguishable from the
  // default rectangle orange (#fb8c00) — hence a crisp blue, contrasting with both
  // the rects' orange and the circles' purple, plus a noticeably thicker stroke
  // (BASE_STROKE_PX is only 1px) so the selection stands out clearly at any zoom level.
  const SELECTED_STROKE_COLOR = '#2196f3';
  const SELECTED_STROKE_WIDTH_MULT = 3;

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
    let baseStroke;
    if (obj.shape === 'circle') {
      baseStroke = '#9c27b0';
      const radius = ((obj.diameter_mm || 40) / scale) / 2;
      shapeNode = new Konva.Circle({
        radius: radius,
        fill: 'rgba(156,39,176,0.25)', stroke: baseStroke, strokeWidth: strokeWidthPx,
        hitStrokeWidth: hitStrokeWidthPx,
      });
    } else {
      baseStroke = '#fb8c00';
      const w = (obj.width_mm || 40) / scale;
      const h = (obj.depth_mm || 40) / scale;
      shapeNode = new Konva.Rect({
        width: w, height: h, offsetX: w / 2, offsetY: h / 2,
        rotation: obj.rotation || 0,
        fill: 'rgba(255,152,0,0.25)', stroke: baseStroke, strokeWidth: strokeWidthPx,
        hitStrokeWidth: hitStrokeWidthPx,
      });
    }
    group.add(shapeNode);

    const fontSizePx = BASE_FONT_PX / (stageScale || 1);
    const label = new Konva.Text({
      text: obj.name || '', fontSize: fontSizePx, fill: labelFillColor(), listening: false,
    });
    positionLabel(label, shapeNode, obj.name_position || 'center', stageScale);
    group.add(label);

    group.placedData = obj;
    group.shapeNode = shapeNode;
    group.labelNode = label;
    group.baseStroke = baseStroke;
    return group;
  }

  // Selection highlight border of a placed object: both color AND thickness change
  // (group.isSelected is stored so that rescaleObjectGroups(), called at each zoom
  // step, knows to reapply the right thickness instead of reverting to the normal one).
  function setGroupSelected(group, isSelected) {
    if (!group || !group.shapeNode) return;
    group.isSelected = isSelected;
    const stage = group.getStage();
    const scale = (stage ? stage.scaleX() : 1) || 1;
    group.shapeNode.stroke(isSelected ? SELECTED_STROKE_COLOR : group.baseStroke);
    group.shapeNode.strokeWidth((BASE_STROKE_PX * (isSelected ? SELECTED_STROKE_WIDTH_MULT : 1)) / scale);
    const layer = group.getLayer();
    if (layer) layer.batchDraw();
  }

  // Reapplies BASE_STROKE_PX/BASE_FONT_PX to all placed objects based on the current
  // zoom (called at each wheel zoom step): without this, text and borders would
  // grow/shrink with the plan's content instead of staying readable at a
  // constant on-screen size. The currently selected object (group.isSelected)
  // keeps its highlight thickness instead of reverting to the normal thickness.
  function rescaleObjectGroups(objectGroups, scale) {
    Object.keys(objectGroups).forEach(function (id) {
      const group = objectGroups[id];
      if (!group.shapeNode || !group.labelNode) return;
      const mult = group.isSelected ? SELECTED_STROKE_WIDTH_MULT : 1;
      group.shapeNode.strokeWidth((BASE_STROKE_PX * mult) / scale);
      group.shapeNode.hitStrokeWidth(HIT_PADDING_PX / scale);
      group.labelNode.fontSize(BASE_FONT_PX / scale);
      positionLabel(group.labelNode, group.shapeNode, group.placedData.name_position || 'center', scale);
    });
  }

  // True if `rotation` (degrees, any sign) is an exact multiple of 90°: only
  // these rotations align the rectangle with orthogonal walls, a required condition for
  // wall snapping (checkbox, and the magnet during drag).
  function isAxisAlignedRotation(rotation) {
    return ((rotation % 90) + 90) % 90 === 0;
  }

  // Half-width/half-height of the axis-aligned bounding box of a Konva.Rect given its
  // current rotation: a 90/270° rotation swaps the visual width and height.
  // Only ever called for rotations that are multiples of 90 (a condition already enforced
  // by initPropertiesPanel before allowing snapping). Result to be passed to
  // flushPositionForWall()/findNearestWall(), never to isFootprintInsidePolygon() (which
  // expects the LOCAL half-extents from localHalfExtents() and applies the
  // rotation itself — passing it this already-rotated AABB would apply it twice).
  function rectHalfExtents(shapeNode, rotation) {
    const w = shapeNode.width(), h = shapeNode.height();
    const normalized = (((Math.round(rotation / 90) * 90) % 180) + 180) % 180;
    if (normalized === 90) return { hw: h / 2, hh: w / 2 };
    return { hw: w / 2, hh: h / 2 };
  }

  // Distance threshold (in logical px) below which the anchor switches to another
  // wall during a drag, and the strength of the "soft" magnetism applied on each dragmove
  // (0 = no attraction, 1 = instant rigid lock).
  const SNAP_RESNAP_THRESHOLD_PX = 20;
  const SNAP_PULL_STRENGTH = 0.35;

  // Finds the wall (orthogonal segment of the zone's polygon) closest to the center
  // (centerX, centerY) and returns {axis, coord, distance}, or null. Non-orthogonal
  // segments (angled walls) are ignored: snapping only applies to
  // rectangles with a rotation that's a multiple of 90°, so they can only be aligned to
  // walls that are themselves orthogonal. `minSegmentLength` ignores small segments (offsets,
  // recesses) shorter than the object itself: without this filter, an object near a corner
  // could "latch onto" a tiny segment next to the real wall, and end up offset on the wrong
  // axis — visually, the object would then cross through the real wall instead of sitting flush against it.
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

  // Looks, around (localX, localY), for the closest reference edge for the
  // "Position by distance" tool (see initPositionTool): either a wall (orthogonal segment
  // of one of the `wallPolygons` polygons), or the edge of another placed object in
  // `groups` (rectangle with a rotation that's a multiple of 90°, same eligibility rule as
  // attachWallMagnet.isEligible() — circles don't expose a natural axis-aligned edge and are
  // ignored as a reference source, even though they remain movable by the tool).
  // Returns the closest candidate within `toleranceCanvasPx`, in the form
  // {distance, axis, coord, source: 'wall'|'device', segmentForHighlight: [a, b], ownerId?}
  // (the same {axis, coord} shape as a wall from findNearestWall, directly reusable by
  // flushPositionForWall), or null if nothing is in range. `excludeGroupId` excludes the
  // object currently being moved; `groupFilter(group)` restricts the candidate objects (e.g.
  // same zone as the object being moved).
  function findReferenceEdgeCandidate(localX, localY, toleranceCanvasPx, wallPolygons, groups, excludeGroupId, groupFilter) {
    let best = null;

    (wallPolygons || []).forEach(function (polygon) {
      polygonEdges(polygon).forEach(function (edge) {
        const a = edge[0], b = edge[1];
        const dx = b[0] - a[0], dy = b[1] - a[1];
        if (Math.hypot(dx, dy) < 1e-6) return;
        const isHorizontal = Math.abs(dy) <= Math.abs(dx) * 0.05;
        const isVertical = Math.abs(dx) <= Math.abs(dy) * 0.05;
        if (!isHorizontal && !isVertical) return;
        const dist = distanceToSegment(localX, localY, a, b);
        if (dist > toleranceCanvasPx) return;
        if (best && dist >= best.distance) return;
        best = isHorizontal
          ? { distance: dist, axis: 'y', coord: (a[1] + b[1]) / 2, source: 'wall', segmentForHighlight: [a, b] }
          : { distance: dist, axis: 'x', coord: (a[0] + b[0]) / 2, source: 'wall', segmentForHighlight: [a, b] };
      });
    });

    const excludeKey = String(excludeGroupId);
    Object.keys(groups || {}).forEach(function (id) {
      if (id === excludeKey) return;
      const group = groups[id];
      if (group.placedData.shape === 'circle') return;
      const rotation = group.placedData.rotation || 0;
      if (!isAxisAlignedRotation(rotation)) return;
      if (groupFilter && !groupFilter(group)) return;
      const { hw, hh } = rectHalfExtents(group.shapeNode, rotation);
      const cx = group.x(), cy = group.y();
      [
        { axis: 'y', coord: cy - hh, a: [cx - hw, cy - hh], b: [cx + hw, cy - hh] }, // top
        { axis: 'y', coord: cy + hh, a: [cx - hw, cy + hh], b: [cx + hw, cy + hh] }, // bottom
        { axis: 'x', coord: cx - hw, a: [cx - hw, cy - hh], b: [cx - hw, cy + hh] }, // left
        { axis: 'x', coord: cx + hw, a: [cx + hw, cy - hh], b: [cx + hw, cy + hh] }, // right
      ].forEach(function (e) {
        const dist = distanceToSegment(localX, localY, e.a, e.b);
        if (dist > toleranceCanvasPx) return;
        if (best && dist >= best.distance) return;
        best = {
          distance: dist, axis: e.axis, coord: e.coord, source: 'device',
          segmentForHighlight: [e.a, e.b], ownerId: group.placedData.id,
        };
      });
    });

    return best;
  }

  // Recentered position so the object's edge touches `wall` exactly (without
  // crossing it), keeping the center's current side relative to the wall.
  // The wall line is centered on the polygon outline (half inside, half outside):
  // "flush against the wall" must therefore target the wall's actual inner face, i.e.
  // the polygon outline offset by WALL_CLEARANCE_PX toward the inside — not the raw
  // outline (which would place the object straddling the wall line).
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

  // "Soft" magnetism while dragging a placed object: as long as the "Snap to
  // wall" checkbox is active, the object remains freely movable but an attraction force
  // continuously pulls it toward its current anchor wall (resistance, not a rigid lock).
  // The anchor is recomputed at the start of each drag (closest wall), and automatically
  // replaced as soon as another wall comes within SNAP_RESNAP_THRESHOLD_PX — outside
  // this threshold, no automatic anchor change occurs. `getPolygon()` returns the zone's
  // polygon in the same coordinate space as group.x()/y() (global for the plan
  // view, local-offset for a room's view).
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
        // The magnet moves the object directly (without going back through dragBoundFunc): so
        // its full footprint must be revalidated here, otherwise the magnetism could itself
        // push the object through a neighboring wall (e.g. near an offset/recess). We validate
        // with the LOCAL half-extents (see localHalfExtents) and not the AABB from
        // halfExtents() above: isFootprintInsidePolygon applies the rotation
        // itself, so passing it an already-rotated AABB would apply it twice — which
        // wrongly made the validation fail for any rectangle rotated 90/270°
        // (typically an object placed lengthwise against a vertical wall).
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
      // To be called at the end of a drag (dragend): snaps fully (flush, without
      // crossing) against the current anchor wall. Returns true if an anchor was active.
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

  // Right-click rotation: each right-click on a placed object rotates its shape by 90°
  // (loops 0→90→180→270→0…). Replaces the old "auto-rotate at wall" mode — the user
  // explicitly chooses when to rotate rather than an automatic rotation during drag.
  // No effect for circles. The rotation is rejected (nothing happens) if it would
  // take the object's footprint outside the zone at its current position. `onRotated(group)`
  // is called after an effective rotation, to persist it server-side and refresh the UI.
  function attachRightClickRotate(group, getPolygon, onRotated) {
    group.on('contextmenu', function (e) {
      e.evt.preventDefault();
      if (group.placedData.shape === 'circle') return;
      // Outside walls: rotation is entirely derived from the angle of the wall against
      // which the object is stuck (see projectOutsidePolygon) — a manual rotation wouldn't
      // make sense and would be overwritten on the next drag anyway.
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

  // Saves x/y (and any extra field in `extra`, e.g. rotation) of a placed
  // object — used after a drag and after a right-click rotation, in both
  // views (full plan and room). `url` is already resolved (see urlFor()).
  function persistPlacedObject(url, obj, extra) {
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRFToken': getCsrfToken() },
      body: JSON.stringify(Object.assign({ x: obj.x, y: obj.y }, extra)),
    });
  }

  // Recenters group/obj onto the zone's closest wall if snapping is
  // possible (rectangle, rotation multiple of 90°); does nothing otherwise. One-off action
  // (checking the "Snap to wall" box) — magnetism during dragging is handled
  // by attachWallMagnet(). Does not persist: the caller is responsible for saving.
  // `getPolygon(group)` returns the zone's polygon (plan view: derived from the group,
  // since each object can be in a different zone; room view: always the same
  // zone, the argument is then ignored). `offsetX/offsetY` shift group.x()/y() (space
  // local to the zone, room view) into obj.x/obj.y (the plan's global space) — leave
  // at 0 for the plan view, where the two spaces already coincide.
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

  // Equivalent of makeTrySnap() for the "Outside walls" option: sticks group/obj against the
  // closest point of the perimeter, on the outside (see projectOutsidePolygon). One-off
  // action (checking the box) — permanent dragging once active is handled by
  // makeDragBoundFunc(). Works for both rectangles AND circles (no rotation
  // restriction, unlike makeTrySnap: rotation is derived automatically).
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

  // Displays the "Objects to place" panel (Racks / Unracked devices tabs) and handles
  // the "Place" action for each row. `resolvePlaceUrl(item)` returns the placement
  // URL to use for that item (differs between the plan view, where each item
  // targets a different zone, and a room's view, where it's always the same zone).
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
        btn.textContent = gettext('Place');
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
      } else if (item.configure_url) {
        const link = document.createElement('a');
        link.href = item.configure_url;
        link.className = 'btn btn-sm btn-outline-secondary';
        link.textContent = gettext('Configure the shape');
        tdAction.appendChild(link);
      } else {
        const span = document.createElement('span');
        span.className = 'text-muted small';
        span.textContent = gettext('Shape not configured');
        tdAction.appendChild(span);
      }
      tr.appendChild(tdAction);
      return tr;
    }

    function render() {
      container.innerHTML = '';

      const nav = document.createElement('ul');
      nav.className = 'nav nav-tabs mb-2';
      [['racks', gettext('Racks')], ['devices', gettext('Unracked devices')]].forEach(function (entry) {
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
        empty.textContent = gettext('No objects available.');
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

  // Displays the "Properties" panel for a placed object selected on the canvas.
  function initPropertiesPanel(container) {
    if (!container) return null;
    const csrftoken = getCsrfToken();

    function clear() {
      container.innerHTML = `<p class="text-muted mb-0">${gettext('Click an object placed on the plan to view its properties.')}</p>`;
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
      snapLabel.textContent = gettext('Snap to wall');
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
      outsideLabel.textContent = gettext('Outside the walls');
      outsideWrapper.appendChild(outsideInput);
      outsideWrapper.appendChild(outsideLabel);
      container.appendChild(outsideWrapper);

      // "Outside the walls" permanently sticks the object to the zone's exterior perimeter
      // (slide-along-the-wall, see projectOutsidePolygon on the JS side); mutually
      // exclusive with "Snap to wall" (which only concerns the interior), and the rotation
      // becomes entirely automatic (derived from the wall's angle), hence not editable.
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
      posLabel.textContent = gettext('Name position');
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

      // Every change (rotation, snapping, name position) is saved
      // immediately server-side — there's no separate "Save" button to click.
      function persist() {
        const payload = {
          name_position: posSelect.value,
          snap_to_wall: snapInput.checked,
          outside_wall: outsideInput.checked,
          x: group.placedData.x,
          y: group.placedData.y,
        };
        if (rotationInput) {
          // Outside the walls: rotation is driven by projectOutsidePolygon() (snap/drag),
          // not by the (disabled) field which may be stale — we read group.placedData
          // directly rather than the value displayed in the input.
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
          // onSnapOutsideNow() just recomputed group.placedData.rotation (immediate
          // snap); resynchronize the displayed field (even though disabled) before persist().
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
      removeBtn.textContent = gettext('Remove from plan');
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

  // Modal "Position by distance" tool: select a placed object, a reference
  // edge (wall or another object's edge), a distance in mm, then the object is moved
  // so its edge touches exactly that distance from the chosen edge (current side
  // preserved — see flushPositionForWall). Unlike the rest of the editor (always
  // active, non-modal), this is the only tool that temporarily suspends the usual
  // dragging and selection while it's active (see the positionTool.isActive() guards
  // in addObjectGroup/clickTargets of initCanvas() and initLocationCanvas()).
  //
  // `deps` : { stage, objectsLayer, getObjectGroups(), getScale(), mmPerPx, urlFor,
  // updateUrlTemplate, offsetX, offsetY, getWallPolygons(moverGroup),
  // getMoverPolygon(moverGroup), getExclusionPolygons(moverGroup),
  // isSameZoneAsMover(group, moverGroup), toggleButtonId, panelId }.
  const POSITION_TOOL_HOVER_COLOR = '#00bcd4';
  const POSITION_TOOL_CONFIRM_COLOR = '#00838f';
  const EDGE_HOVER_TOLERANCE_PX = 12;

  function initPositionTool(deps) {
    const toggleButton = document.getElementById(deps.toggleButtonId);
    const panel = document.getElementById(deps.panelId);
    if (!toggleButton || !panel) return null;

    let active = false;
    let step = 'idle'; // 'idle' | 'pick-device' | 'pick-edge' | 'enter-distance'
    let mover = null;
    let confirmedEdge = null;
    let moverHighlightNode = null;
    let hoverEdgeNode = null;
    let edgeConfirmNode = null;
    let keydownHandler = null;

    function destroyNode(node) {
      if (node) node.destroy();
      return null;
    }

    function tolerancePx() {
      return EDGE_HOVER_TOLERANCE_PX / deps.getScale();
    }

    function toLocalPoint(pos) {
      return deps.objectsLayer.getAbsoluteTransform().copy().invert().point(pos);
    }

    function moverHalfExtents() {
      if (mover.placedData.shape === 'circle') {
        const r = mover.shapeNode.radius();
        return { hw: r, hh: r };
      }
      return rectHalfExtents(mover.shapeNode, mover.placedData.rotation || 0);
    }

    function currentReferenceCandidate() {
      const pointer = deps.stage.getPointerPosition();
      if (!pointer) return null;
      const local = toLocalPoint(pointer);
      return findReferenceEdgeCandidate(
        local.x, local.y, tolerancePx(),
        deps.getWallPolygons(mover), deps.getObjectGroups(), mover.placedData.id,
        function (g) { return deps.isSameZoneAsMover(g, mover); }
      );
    }

    function drawMoverHighlight() {
      moverHighlightNode = destroyNode(moverHighlightNode);
      const rotation = mover.placedData.rotation || 0;
      const pad = 4 / deps.getScale();
      const strokeWidth = 2 / deps.getScale();
      if (mover.placedData.shape === 'circle') {
        moverHighlightNode = new Konva.Circle({
          x: mover.x(), y: mover.y(), radius: mover.shapeNode.radius() + pad,
          stroke: COLORS.selected.stroke, strokeWidth: strokeWidth, listening: false,
        });
      } else {
        const { hw, hh } = localHalfExtents(mover);
        moverHighlightNode = new Konva.Rect({
          x: mover.x(), y: mover.y(),
          width: (hw + pad) * 2, height: (hh + pad) * 2,
          offsetX: hw + pad, offsetY: hh + pad,
          rotation: rotation,
          stroke: COLORS.selected.stroke, strokeWidth: strokeWidth, listening: false,
        });
      }
      deps.objectsLayer.add(moverHighlightNode);
      deps.objectsLayer.batchDraw();
    }

    function drawEdgeLine(segment, color, dashed) {
      const node = new Konva.Line({
        points: [segment[0][0], segment[0][1], segment[1][0], segment[1][1]],
        stroke: color, strokeWidth: 3 / deps.getScale(),
        listening: false,
      });
      if (dashed) node.dash([6 / deps.getScale(), 4 / deps.getScale()]);
      deps.objectsLayer.add(node);
      return node;
    }

    // Current gap (mm) between the mover's relevant edge and confirmedEdge — starting
    // value displayed in the distance field, handy for tweaking a nearby value
    // rather than starting from zero.
    function currentGapMm() {
      const { hw, hh } = moverHalfExtents();
      const half = confirmedEdge.axis === 'y' ? hh : hw;
      const center = confirmedEdge.axis === 'y' ? mover.y() : mover.x();
      const gapPx = Math.max(0, Math.abs(center - confirmedEdge.coord) - half);
      return gapPx * deps.mmPerPx;
    }

    function addCancelButton() {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-outline-secondary btn-sm mt-2';
      btn.textContent = gettext('Cancel');
      btn.addEventListener('click', function () { setActive(false); });
      panel.appendChild(btn);
    }

    function renderPanel() {
      panel.innerHTML = '';

      if (step === 'idle') {
        const p = document.createElement('p');
        p.className = 'text-muted mb-0';
        p.textContent = gettext('Activate the tool above the plan, then click the device to move.');
        panel.appendChild(p);
        return;
      }

      if (step === 'pick-device') {
        const p = document.createElement('p');
        p.textContent = gettext('Click the device you want to move.');
        panel.appendChild(p);
        addCancelButton();
        return;
      }

      if (step === 'pick-edge') {
        const p1 = document.createElement('p');
        p1.className = 'mb-1';
        const strong = document.createElement('strong');
        strong.textContent = gettext('Moving:') + ' ';
        p1.appendChild(strong);
        p1.appendChild(document.createTextNode(mover.placedData.name || ''));
        panel.appendChild(p1);
        const p2 = document.createElement('p');
        p2.className = 'text-muted';
        p2.textContent = gettext('Hover a wall or a device edge, then click to select it.');
        panel.appendChild(p2);
        addCancelButton();
        return;
      }

      // step === 'enter-distance'
      const refP = document.createElement('p');
      refP.className = 'mb-1';
      if (confirmedEdge.source === 'wall') {
        refP.textContent = gettext('Reference: a wall');
      } else {
        const ownerGroup = deps.getObjectGroups()[confirmedEdge.ownerId];
        refP.textContent = interpolate(
          gettext('Reference: edge of %(name)s'),
          { name: ownerGroup ? (ownerGroup.placedData.name || '') : '' },
          true
        );
      }
      panel.appendChild(refP);

      const label = document.createElement('label');
      label.className = 'form-label';
      label.textContent = gettext('Distance (mm)');
      panel.appendChild(label);

      const input = document.createElement('input');
      input.type = 'number';
      input.step = 'any';
      input.min = '0';
      input.className = 'form-control mb-2';
      input.value = currentGapMm().toFixed(1);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); applyDistance(input, feedback); }
      });
      panel.appendChild(input);

      const feedback = document.createElement('div');
      feedback.className = 'text-danger small mb-2';
      panel.appendChild(feedback);

      const applyBtn = document.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'btn btn-primary btn-sm me-2';
      applyBtn.textContent = gettext('Apply');
      applyBtn.addEventListener('click', function () { applyDistance(input, feedback); });
      panel.appendChild(applyBtn);

      addCancelButton();
    }

    function applyDistance(input, feedback) {
      feedback.textContent = '';
      const mm = parseFloat(input.value);
      if (Number.isNaN(mm)) {
        feedback.textContent = gettext('Enter a valid distance.');
        return;
      }
      if (mm < 0) {
        feedback.textContent = gettext('Distance must be zero or greater.');
        return;
      }

      const requestedGapPx = mm / deps.mmPerPx;
      const rotation = mover.placedData.rotation || 0;
      const { hw, hh } = moverHalfExtents();
      // Direct reuse of flushPositionForWall (edge-to-edge move, current side
      // preserved): confirmedEdge, whether a wall or a device edge, has the same
      // {axis, coord} shape as a regular wall — no adaptation is needed.
      const target = flushPositionForWall(mover.x(), mover.y(), hw, hh, confirmedEdge, requestedGapPx);

      // Validation with the usual structural margin (not requestedGapPx: that
      // value only concerns the chosen reference edge, not the object's confinement
      // within its own room) and the un-rotated LOCAL half-extents — same rules as
      // makeDragBoundFunc/attachWallMagnet (see their comments on this point).
      const validationClearance = resolvedClearance(deps.getScale);
      const { hw: localHw, hh: localHh } = localHalfExtents(mover);
      const roomPolygon = deps.getMoverPolygon(mover);
      const exclusions = deps.getExclusionPolygons(mover) || [];
      const valid = !!target && !!roomPolygon &&
        isFootprintInsidePolygon(mover.placedData.shape, target.x, target.y, localHw, localHh, rotation, roomPolygon, validationClearance) &&
        exclusions.every(function (excl) {
          return !footprintOverlapsPolygon(mover.placedData.shape, target.x, target.y, localHw, localHh, rotation, excl, validationClearance);
        });

      if (!valid) {
        feedback.textContent = gettext('This position is not valid: the object would be outside the room or overlapping another zone.');
        return;
      }

      mover.x(target.x);
      mover.y(target.y);
      mover.getLayer().draw();
      mover.placedData.x = target.x + deps.offsetX;
      mover.placedData.y = target.y + deps.offsetY;
      persistPlacedObject(deps.urlFor(deps.updateUrlTemplate, mover.placedData.id), mover.placedData, { rotation: mover.placedData.rotation });

      moverHighlightNode = destroyNode(moverHighlightNode);
      edgeConfirmNode = destroyNode(edgeConfirmNode);
      deps.objectsLayer.batchDraw();
      mover = null;
      confirmedEdge = null;
      step = 'pick-device';
      renderPanel();
    }

    // Returns true if this click was consumed by the "pick-device" step (mover
    // selection or rotation warning) — the calling group must then cancel Konva's
    // bubbling to the stage, otherwise that same click would also reach onStageClick right
    // after switching to step = 'pick-edge' and would immediately confirm a reference edge
    // under the cursor (common: a device is often close to a wall).
    function handleObjectClick(group) {
      if (!active || step !== 'pick-device') return false;
      const rotation = group.placedData.rotation || 0;
      if (group.placedData.shape !== 'circle' && !isAxisAlignedRotation(rotation)) {
        panel.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = gettext('Click the device you want to move.');
        panel.appendChild(p);
        const warn = document.createElement('p');
        warn.className = 'text-danger small';
        warn.textContent = gettext('This object cannot be positioned with this tool: its rotation must be 0°, 90°, 180° or 270°.');
        panel.appendChild(warn);
        addCancelButton();
        return true;
      }
      mover = group;
      step = 'pick-edge';
      drawMoverHighlight();
      renderPanel();
      return true;
    }

    function onMouseMove() {
      if (!active || step !== 'pick-edge') return;
      const candidate = currentReferenceCandidate();
      hoverEdgeNode = destroyNode(hoverEdgeNode);
      if (candidate) hoverEdgeNode = drawEdgeLine(candidate.segmentForHighlight, POSITION_TOOL_HOVER_COLOR, true);
      deps.objectsLayer.batchDraw();
    }

    function onStageClick() {
      if (!active || step !== 'pick-edge') return;
      const candidate = currentReferenceCandidate();
      if (!candidate) return;
      confirmedEdge = candidate;
      hoverEdgeNode = destroyNode(hoverEdgeNode);
      edgeConfirmNode = destroyNode(edgeConfirmNode);
      edgeConfirmNode = drawEdgeLine(candidate.segmentForHighlight, POSITION_TOOL_CONFIRM_COLOR, false);
      deps.objectsLayer.batchDraw();
      step = 'enter-distance';
      renderPanel();
    }

    function onKeyDown(e) {
      if (e.key === 'Escape' && active) setActive(false);
    }

    function setActive(next) {
      if (active === next) return;
      active = next;
      if (active) {
        step = 'pick-device';
        mover = null;
        confirmedEdge = null;
        toggleButton.classList.add('active', 'btn-primary');
        toggleButton.classList.remove('btn-outline-secondary');
        deps.stage.container().style.cursor = 'crosshair';
        deps.stage.on('mousemove.postool', onMouseMove);
        deps.stage.on('click.postool', onStageClick);
        keydownHandler = onKeyDown;
        document.addEventListener('keydown', keydownHandler);
      } else {
        step = 'idle';
        mover = null;
        confirmedEdge = null;
        moverHighlightNode = destroyNode(moverHighlightNode);
        hoverEdgeNode = destroyNode(hoverEdgeNode);
        edgeConfirmNode = destroyNode(edgeConfirmNode);
        deps.objectsLayer.batchDraw();
        toggleButton.classList.remove('active', 'btn-primary');
        toggleButton.classList.add('btn-outline-secondary');
        deps.stage.container().style.cursor = '';
        deps.stage.off('.postool');
        if (keydownHandler) {
          document.removeEventListener('keydown', keydownHandler);
          keydownHandler = null;
        }
      }
      renderPanel();
    }

    toggleButton.addEventListener('click', function () { setActive(!active); });
    renderPanel();

    return {
      isActive: function () { return active; },
      handleObjectClick: handleObjectClick,
    };
  }

  // Draws the zones on the Konva canvas and returns a small API so
  // initAssociationPanel() can react to clicks and recolor the zones.
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

    // getFitStageSize (not getResponsiveStageSize/getFillStageSize): a plan whose
    // logical size is smaller than the Bootstrap card must be enlarged to fill
    // the container, but never exceeding maxHeight (otherwise the bottom of the plan would be cropped
    // out of view, see its comment) — and centered in the space thus freed up.
    let size = getFitStageSize(container, width, height, height, 0.04);
    container.style.height = size.height + 'px';
    const stage = new Konva.Stage({
      container: 'np-canvas',
      width: size.width,
      height: size.height,
      scaleX: size.scale,
      scaleY: size.scale,
      x: size.x,
      y: size.y,
      pixelRatio: window.devicePixelRatio || 1,
    });
    attachWheelZoom(stage, function () { return objectGroups; });
    // Adapts zone label size to the current zoom: targets BASE_ZONE_LABEL_PX
    // screen pixels, capped at maxFontCanvas so it doesn't overflow the zone. Shared between
    // wheel zoom and centerView() (the "General view" button).
    function refreshZoomVisuals(scale) {
      const sw = ZONE_STROKE_SCREEN_PX / scale;
      zoneStrokeLines.forEach(function (l) { l.strokeWidth(sw); });
      Object.keys(labels).forEach(function (num) {
        const lbl = labels[num];
        if (!lbl) return;
        lbl.fontSize(Math.min(lbl.getAttr('maxFontCanvas'), BASE_ZONE_LABEL_PX / scale));
        lbl.offsetY(lbl.height() / 2);
      });
    }
    stage.on('wheel', function () {
      refreshZoomVisuals(stage.scaleX());
      // stage.batchDraw() is already scheduled by attachWheelZoom — no extra draw needed.
    });
    attachPanning(stage);
    const layer = new Konva.Layer();
    stage.add(layer);

    const objectsLayer = new Konva.Layer();
    stage.add(objectsLayer);
    const objectGroups = {}; // placed object id -> Konva.Group
    let onObjectSelect = null; // callback(group|null) defined by initPlacedObjectsUI
    let positionTool = null; // assigned further below (see initPositionTool); read via closure

    let selectedGroup = null;
    // `forceRefresh`: right-click rotation modifies group.placedData.rotation of an
    // object that may already be selected (selectedGroup === group), so without this
    // parameter the "no selection change" short-circuit below would prevent
    // the Properties panel from redrawing with the new angle.
    function selectObjectGroup(group, forceRefresh) {
      const changed = selectedGroup !== group;
      if (changed) {
        if (selectedGroup) setGroupSelected(selectedGroup, false);
        selectedGroup = group;
        if (selectedGroup) setGroupSelected(selectedGroup, true);
      }
      if ((changed || forceRefresh) && onObjectSelect) onObjectSelect(selectedGroup);
    }

    // A click that doesn't hit any shape (device/rack, zone...) hits the stage
    // directly (Konva.Stage has no opaque background listening for clicks): this is the only
    // reliable case to detect "the user clicked outside" and deselect.
    stage.on('click tap', function (e) {
      if (e.target !== stage) return;
      if (positionTool && positionTool.isActive()) return;
      selectObjectGroup(null);
    });

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
      // stage.scaleX() (current zoom), not size.scale (frozen initial fit
      // scale): an object placed after a wheel zoom must be born at the right
      // on-screen size immediately, without waiting for the next zoom step.
      const getZoneHoles = function () { return holesOf[obj.zone_number] || []; };
      const group = buildPlacedGroup(obj, mmPerPx, 0, 0, true, stage.scaleX());
      group.dragBoundFunc(makeDragBoundFunc(group, function () { return zonePolygon(obj.zone_number); }, getScale, getZoneHoles));
      const magnet = attachWallMagnet(group, function () { return zonePolygon(obj.zone_number); }, getScale, null, getZoneHoles);
      group.on('click tap', function (e) {
        if (positionTool && positionTool.isActive()) {
          if (positionTool.handleObjectClick(group)) e.cancelBubble = true;
          return;
        }
        e.cancelBubble = true;
        selectObjectGroup(group);
      });
      group.on('dragstart', function () {
        if (positionTool && positionTool.isActive()) group.stopDrag();
      });
      group.on('dragend', function () {
        magnet.finalize();
        obj.x = group.x();
        obj.y = group.y();
        // Outside the walls: rotation may have changed during the drag (following the
        // perimeter around a corner) — always include rotation to stay up to date, without
        // any special condition since an "inside" object never modifies it
        // during a plain drag anyway.
        persistPlacedObject(urlFor(updateUrlTemplate, obj.id), obj, { rotation: obj.rotation });
      });
      attachRightClickRotate(group, function () { return zonePolygon(obj.zone_number); }, function () {
        obj.rotation = group.shapeNode.rotation();
        persistPlacedObject(urlFor(updateUrlTemplate, obj.id), obj, { rotation: obj.rotation });
        selectObjectGroup(group, true);
      });
      objectsLayer.add(group);
      objectGroups[obj.id] = group;
      objectsLayer.draw();
      return group;
    }

    const lines = {}; // zone number -> Konva.Line
    const labels = {}; // zone number -> Konva.Text (zone number, or room name once associated)
    const zoneStrokeLines = []; // all zone outline Konva.Line instances, for strokeWidth updates on zoom
    let selectedNumber = null;
    let onSelect = null; // callback(zone|null) defined by initAssociationPanel

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

    // Geometric centroid (Gauss/shoelace formula) — weighted by triangle
    // areas, not a simple average of the vertices. Stays inside for convex
    // polygons and almost always inside for the L/U shapes encountered in practice.
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

    // Sort zones from largest to smallest: outer zones first (low z),
    // inner zones last (high z) — essential so the hit canvas prioritizes
    // the inner zone on a click within its area (painted later = wins).
    zones.sort(function (a, b) {
      return Math.abs(polygonSignedArea(b.polygon)) - Math.abs(polygonSignedArea(a.polygon));
    });

    // Direct parent of each zone = the smallest zone containing its centroid.
    // Only direct children form holes in their parent zone (deep descendants
    // are excluded: they'll be handled as holes of their own direct parent).
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
        // Simple zone: a single Konva.Line handles both the visual and the hit canvas.
        const pts = [];
        zone.polygon.forEach(function (p) { pts.push(p[0], p[1]); });
        const line = new Konva.Line({ points: pts, closed: true, strokeWidth: ZONE_STROKE_SCREEN_PX / size.scale });
        layer.add(line);
        zoneShape = line;
        zoneStrokeLines.push(line);
        clickTargets = [line];
      } else {
        // Outer zone with nested zones — three shapes:
        // • fillPath (Konva.Path, evenodd, listening:false): visual rendering with clean holes
        //   and no seam; absent from the hit canvas (listening:false).
        // • hitLine (Konva.Line, transparent fill): covers the entire area in the hit canvas;
        //   inner zones added afterward (higher z) overwrite its hit color within their
        //   areas → a click inside an inner zone selects the inner zone, not this one.
        // • strokeLine (Konva.Line, empty fill): visible outline + hit on the border only.
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
      // Geometric centroid, with successive fallbacks if the point falls outside the polygon
      // (happens for L-shapes, U-shapes, zones with notches).
      let [lcx, lcy] = areaCentroid(zone.polygon);
      if (!pointInPolygon(lcx, lcy, zone.polygon)) {
        // Fallback 1: average of the vertices
        let vx = 0, vy = 0;
        zone.polygon.forEach(function (p) { vx += p[0]; vy += p[1]; });
        lcx = vx / zone.polygon.length;
        lcy = vy / zone.polygon.length;
      }
      if (!pointInPolygon(lcx, lcy, zone.polygon)) {
        // Fallback 2: 6×6 grid within the bbox (edge midpoints sit on the boundary,
        // rejected by pointInPolygon's strict inequalities — hence switching to a grid
        // with points strictly inside the bbox, not on its border).
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
      // For an outer zone (with holes), the centroid may fall inside an inner zone
      // that draws on top of it. Search for a point in the corridor (inside the outer
      // polygon, outside all holes) using a 9×9 grid.
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
      // Vertical scan: recenter lcy within the range actually available at lcx.
      // Without this, a centroid near the zone's top edge would make the label overflow above
      // the perimeter (the top half of the label sticks out of the zone).
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
      // Limit labelW to the horizontal space actually available around (lcx, lcy):
      // without this, for an outer zone with a narrow corridor, the text overflows the perimeter
      // even though the label's center is correctly positioned within the corridor.
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
      // maxFontCanvas computed after the corridor scan to include the labelW/4 cap;
      // stored on the label so it can be reused by the wheel handler (adaptive zoom).
      const maxFontCanvas = Math.max(4, Math.min(20, zoneDim * 0.18, labelW / 4));
      const label = new Konva.Text({
        x: lcx,
        y: lcy,
        text: zone.location_name || String(zone.number),
        fontSize: Math.min(maxFontCanvas, BASE_ZONE_LABEL_PX / size.scale),
        fontStyle: 'bold',
        fill: labelFillColor(),
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
          if (positionTool && positionTool.isActive()) return;
          // A click on the zone (but not on a device/rack placed on it, which has its
          // own click target above it) counts as "outside" any placed object.
          selectObjectGroup(null);
          selectedNumber = selectedNumber === zone.number ? null : zone.number;
          repaint();
          if (onSelect) onSelect(selectedNumber === null ? null : zone);
        });
      });

      (zone.objects || []).forEach(function (obj) { addObjectGroup(obj); });
    });

    repaint();

    onThemeChange(function () {
      const fill = labelFillColor();
      Object.keys(labels).forEach(function (num) { labels[num].fill(fill); });
      Object.keys(objectGroups).forEach(function (id) { objectGroups[id].labelNode.fill(fill); });
      layer.batchDraw();
      objectsLayer.batchDraw();
    });

    positionTool = initPositionTool({
      stage: stage,
      objectsLayer: objectsLayer,
      getObjectGroups: function () { return objectGroups; },
      getScale: getScale,
      mmPerPx: mmPerPx,
      urlFor: urlFor,
      updateUrlTemplate: updateUrlTemplate,
      offsetX: 0,
      offsetY: 0,
      getWallPolygons: function (mv) {
        const poly = zonePolygon(mv.placedData.zone_number);
        return poly ? [poly].concat(holesOf[mv.placedData.zone_number] || []) : [];
      },
      getMoverPolygon: function (mv) { return zonePolygon(mv.placedData.zone_number); },
      getExclusionPolygons: function (mv) { return holesOf[mv.placedData.zone_number] || []; },
      isSameZoneAsMover: function (g, mv) { return g.placedData.zone_number === mv.placedData.zone_number; },
      toggleButtonId: 'np-position-tool-btn',
      panelId: 'np-position-tool-panel',
    });

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
        if (group) {
          if (selectedGroup === group) selectObjectGroup(null);
          group.destroy();
          delete objectGroups[id];
          objectsLayer.draw();
        }
      },
      // The server removes devices/racks placed in a zone that was just unlinked
      // from a room (see plan_save_associations): we reflect this immediately in
      // the canvas, without reloading the page.
      removePlacedObjectsForZone: function (zoneNumber) {
        Object.keys(objectGroups).forEach(function (id) {
          const group = objectGroups[id];
          if (group.placedData.zone_number === zoneNumber) {
            if (selectedGroup === group) selectObjectGroup(null);
            group.destroy();
            delete objectGroups[id];
          }
        });
        objectsLayer.draw();
      },
      trySnap: trySnap,
      trySnapOutside: trySnapOutside,
      getScale: function () { return stage.scaleX(); },
      // "General view" button: recenters and readjusts the zoom so the whole plan
      // becomes visible again, as on initial load (see getFitStageSize).
      centerView: function () {
        size = getFitStageSize(container, width, height, height, 0.04);
        container.style.height = size.height + 'px';
        stage.width(size.width);
        stage.height(size.height);
        stage.scale({ x: size.scale, y: size.scale });
        stage.position({ x: size.x, y: size.y });
        refreshZoomVisuals(size.scale);
        rescaleObjectGroups(objectGroups, size.scale);
        layer.batchDraw();
        objectsLayer.batchDraw();
      },
    };
  }

  function initAssociationPanel(canvas, onSaved) {
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
      title.innerHTML = `<strong>${interpolate(gettext('Zone %(number)s selected'), { number: zone.number }, true)}</strong>`;
      panel.appendChild(title);

      const select = document.createElement('select');
      select.className = 'form-select mb-2';

      const noneOption = document.createElement('option');
      noneOption.value = '';
      noneOption.textContent = gettext('— No location —');
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
      assocBtn.textContent = interpolate(gettext('Associate with zone %(number)s'), { number: zone.number }, true);
      assocBtn.addEventListener('click', function () {
        const locationId = select.value ? parseInt(select.value, 10) : null;
        const isUnlinking = !!zone.location_id && !locationId;
        if (isUnlinking) {
          const confirmMessage = interpolate(
            gettext(
              'Are you sure you want to unlink location "%(location_name)s" from zone %(number)s? ' +
              'Once saved, the "Plan" tab will disappear from this location\'s page, the zone number ' +
              'will reappear on the plan instead of its name, and the devices/racks placed in this zone ' +
              'will be removed from it (they will remain in their NetBox location, but will no longer be placed on the plan).'
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
        panel.innerHTML = `<p class="text-muted mb-0">${gettext('Click a zone on the plan to associate it with a location.')}</p>`;
        return;
      }
      panel.innerHTML = `<p class="text-muted mb-0">${gettext('Loading locations…')}</p>`;
      fetchLocations()
        .then(function (locations) { renderPanel(zone, locations); })
        .catch(function () {
          panel.innerHTML = `<p class="text-danger mb-0">${gettext('Error loading locations.')}</p>`;
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
            // Any zone saved without a location (unlinked) has its devices/racks removed
            // server-side (see plan_save_associations); we apply this here too
            // so their markers aren't left displayed until the next reload.
            associations.forEach(function (a) {
              if (!a.location_id) canvas.removePlacedObjectsForZone(a.zone_number);
            });
            // A (un)linked association changes the set of placeable objects (see
            // plan_pickable_objects server-side, filtered by associated locations).
            if (onSaved) onSaved();
            if (!feedback) return;
            if (data.errors && data.errors.length) {
              feedback.innerHTML = `<span class="text-danger">${data.errors.join('<br>')}</span>`;
            } else {
              const savedMessage = interpolate(gettext('%(saved)s association(s) saved.'), { saved: data.saved }, true);
              feedback.innerHTML = `<span class="text-success">${savedMessage}</span>`;
            }
          })
          .catch(function () {
            saveBtn.disabled = false;
            if (feedback) feedback.innerHTML = `<span class="text-danger">${gettext('Network error while saving.')}</span>`;
          });
      });
    }
  }

  // Plan view: connects the "Objects to place" panel and the "Properties" panel to
  // the canvas already built by initCanvas(). Each placeable item carries a zone_number
  // (see plan_pickable_objects server-side) which is resolved into a zone_pk via canvas.zones.
  function initPlacedObjectsUI(canvas) {
    const pickableContainer = document.getElementById('np-pickable-panel');
    const propertiesContainer = document.getElementById('np-properties-panel');
    if (!canvas || !pickableContainer) return null;

    const properties = initPropertiesPanel(propertiesContainer);

    function resolvePlaceUrl(item) {
      const zone = canvas.zones.find(function (z) { return z.number === item.zone_number; });
      const template = pickableContainer.dataset.placeUrlTemplate;
      // The place_object template is built with a placeholder zone pk (see
      // plan.html/plan_tab.html); we replace it with the target zone's real pk.
      return zone ? template.replace('999999', zone.pk) : null;
    }

    const pickable = initPickablePanel(pickableContainer, pickableContainer.dataset.pickableUrl, resolvePlaceUrl, function (obj) {
      canvas.addPlacedObject(obj);
    });

    canvas.onObjectSelected(function (group) {
      if (!group) { properties.clear(); return; }
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

    return pickable;
  }

  // A room's view (a Location's "Plan" tab): standalone canvas displaying a
  // single zone, recentered on a local origin (same offset as extract_zone_svg()
  // server-side). Placed objects' coordinates are already expressed in the plan's
  // global space (PlacedObject.x/y); we offset them here by offsetX/offsetY to
  // display them in this local frame — it's the same database row as the plan view,
  // simply projected differently, which keeps the two views in sync.
  function initLocationCanvas() {
    const container = document.getElementById('np-loc-canvas');
    if (!container || typeof Konva === 'undefined') return;

    // Hidden tab (display:none) → clientWidth=0 → getFillStageSize would fall back to
    // scale=1 (raw data size) instead of the Bootstrap card's actual size.
    // We bail out here; shown.bs.tab (registered in DOMContentLoaded) will call this
    // function again once the tab is fully visible and clientWidth is correct.
    if (container.clientWidth === 0) return;

    // Guard: avoids double initialization if shown.bs.tab fires multiple times.
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

    // "General view" (view all): the whole room must always be visible, centered,
    // with a margin — not just fitted to the container's width (see getFitStageSize).
    let size = getFitStageSize(container, width, height, 700, 0.08);
    container.style.height = size.height + 'px';
    const stage = new Konva.Stage({
      container: 'np-loc-canvas',
      width: size.width,
      height: size.height,
      scaleX: size.scale,
      scaleY: size.scale,
      x: size.x,
      y: size.y,
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
      // Outer zone with sub-zones: fillPath (evenodd) for the visual holes + strokeLine
      // for the outer outline. Fill is absent from strokeLine so it doesn't cover the holes.
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
      // Inner zone outlines: draws the rooms' walls and marks the
      // placement boundaries (objects can't be placed within these areas).
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
    // Shared between wheel zoom and centerView() (the "General view" button).
    function refreshStrokeWidths(scale) {
      const sw = ZONE_STROKE_SCREEN_PX / scale;
      strokeLines.forEach(function (l) { l.strokeWidth(sw); });
      layer.batchDraw();
    }
    stage.on('wheel', function () { refreshStrokeWidths(stage.scaleX()); });

    const objectsLayer = new Konva.Layer();
    stage.add(objectsLayer);
    const objectGroups = {};
    let onObjectSelect = null; // callback(group|null)
    let positionTool = null; // assigned further below (see initPositionTool); read via closure
    const getScale = function () { return stage.scaleX(); };
    const getLocalPolygon = function () { return localPolygon; };

    let selectedGroup = null;
    // `forceRefresh`: right-click rotation modifies group.placedData.rotation of an
    // object that may already be selected (selectedGroup === group), so without this
    // parameter the "no selection change" short-circuit below would prevent
    // the Properties panel from redrawing with the new angle.
    function selectObjectGroup(group, forceRefresh) {
      const changed = selectedGroup !== group;
      if (changed) {
        if (selectedGroup) setGroupSelected(selectedGroup, false);
        selectedGroup = group;
        if (selectedGroup) setGroupSelected(selectedGroup, true);
      }
      if ((changed || forceRefresh) && onObjectSelect) onObjectSelect(selectedGroup);
    }

    stage.on('click tap', function (e) {
      if (e.target !== stage) return;
      if (positionTool && positionTool.isActive()) return;
      selectObjectGroup(null);
    });

    // Snap targets: edges of the inner zones (for snapping — actual wall surfaces).
    const getLocalInnerPolygons = localInnerPolygons.length > 0
      ? function () { return localInnerPolygons; }
      : null;

    // Exclusion: inner zones (objects can't be placed inside the rooms).
    const getLocalExclusionPolygons = localInnerPolygons.length > 0
      ? function () { return localInnerPolygons; }
      : null;

    const trySnap = makeTrySnap(getLocalPolygon, offsetX, offsetY, getScale, getLocalInnerPolygons, getLocalExclusionPolygons);
    const trySnapOutside = makeTrySnapOutside(getLocalPolygon, offsetX, offsetY, getScale);

    function addObjectGroup(obj) {
      const group = buildPlacedGroup(obj, mmPerPx, offsetX, offsetY, true, stage.scaleX());
      group.dragBoundFunc(makeDragBoundFunc(group, getLocalPolygon, getScale, getLocalExclusionPolygons));
      const magnet = attachWallMagnet(group, getLocalPolygon, getScale, getLocalInnerPolygons, getLocalExclusionPolygons);
      group.on('click tap', function (e) {
        if (positionTool && positionTool.isActive()) {
          if (positionTool.handleObjectClick(group)) e.cancelBubble = true;
          return;
        }
        e.cancelBubble = true;
        selectObjectGroup(group);
      });
      group.on('dragstart', function () {
        if (positionTool && positionTool.isActive()) group.stopDrag();
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
        selectObjectGroup(group, true);
      });
      objectsLayer.add(group);
      objectGroups[obj.id] = group;
      objectsLayer.draw();
      return group;
    }

    objects.forEach(function (obj) { addObjectGroup(obj); });

    onThemeChange(function () {
      const fill = labelFillColor();
      Object.keys(objectGroups).forEach(function (id) { objectGroups[id].labelNode.fill(fill); });
      objectsLayer.batchDraw();
    });

    const canvasApi = {
      mmPerPx: mmPerPx,
      updateUrlTemplate: updateUrlTemplate,
      removeUrlTemplate: removeUrlTemplate,
      urlFor: urlFor,
      onObjectSelected: function (callback) { onObjectSelect = callback; },
      addPlacedObject: function (obj) { return addObjectGroup(obj); },
      removePlacedObject: function (id) {
        const group = objectGroups[id];
        if (group) {
          if (selectedGroup === group) selectObjectGroup(null);
          group.destroy();
          delete objectGroups[id];
          objectsLayer.draw();
        }
      },
      trySnap: trySnap,
      trySnapOutside: trySnapOutside,
      // "General view" button: recenters and readjusts the zoom to restore the
      // initial view (whole room visible, centered, with a margin — see getFitStageSize).
      centerView: function () {
        size = getFitStageSize(container, width, height, 700, 0.08);
        container.style.height = size.height + 'px';
        stage.width(size.width);
        stage.height(size.height);
        stage.scale({ x: size.scale, y: size.scale });
        stage.position({ x: size.x, y: size.y });
        refreshStrokeWidths(size.scale);
        rescaleObjectGroups(objectGroups, size.scale);
        objectsLayer.batchDraw();
      },
    };

    const centerViewBtn = document.getElementById('np-loc-center-view-btn');
    if (centerViewBtn) {
      centerViewBtn.addEventListener('click', function () { canvasApi.centerView(); });
    }

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
        if (!group) { properties.clear(); return; }
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

    positionTool = initPositionTool({
      stage: stage,
      objectsLayer: objectsLayer,
      getObjectGroups: function () { return objectGroups; },
      getScale: getScale,
      mmPerPx: mmPerPx,
      urlFor: urlFor,
      updateUrlTemplate: updateUrlTemplate,
      offsetX: offsetX,
      offsetY: offsetY,
      getWallPolygons: function () { return [localPolygon].concat(localInnerPolygons); },
      getMoverPolygon: function () { return localPolygon; },
      getExclusionPolygons: function () { return localInnerPolygons; },
      isSameZoneAsMover: function () { return true; },
      toggleButtonId: 'np-loc-position-tool-btn',
      panelId: 'np-loc-position-tool-panel',
    });
  }
})();
