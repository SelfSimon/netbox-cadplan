import pytest

from netbox_plan import utils


def test_is_effectively_closed_true_for_near_identical_endpoints():
    points = [[0, 0], [10, 0], [10, 10], [0, 10], [0.0001, 0.0001]]
    assert utils._is_effectively_closed(points)


def test_is_effectively_closed_false_for_open_polyline():
    points = [[0, 0], [10, 0], [10, 10]]
    assert not utils._is_effectively_closed(points)


def test_is_effectively_closed_false_below_three_points():
    assert not utils._is_effectively_closed([[0, 0], [1, 1]])


def test_polygon_fingerprint_square():
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    fp = utils.polygon_fingerprint(square)
    assert fp["area"] == 100
    assert fp["vertex_count"] == 4
    assert fp["centroid"] == (5, 5)


def test_fingerprints_match_within_tolerance():
    fp1 = {"area": 100.0, "vertex_count": 4, "centroid": (0, 0)}
    fp2 = {"area": 100.5, "vertex_count": 4, "centroid": (0, 0)}
    assert utils.fingerprints_match(fp1, fp2)


def test_fingerprints_match_rejects_different_vertex_count():
    fp1 = {"area": 100.0, "vertex_count": 4, "centroid": (0, 0)}
    fp2 = {"area": 100.0, "vertex_count": 3, "centroid": (0, 0)}
    assert not utils.fingerprints_match(fp1, fp2)


def test_fingerprints_match_rejects_area_beyond_tolerance():
    fp1 = {"area": 100.0, "vertex_count": 4, "centroid": (0, 0)}
    fp2 = {"area": 50.0, "vertex_count": 4, "centroid": (0, 0)}
    assert not utils.fingerprints_match(fp1, fp2)


class DummyZone:
    def __init__(self, pk, source_polygon):
        self.pk = pk
        self.source_polygon = source_polygon


def test_match_zones_to_polygons_simple():
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    zone = DummyZone(pk=1, source_polygon=square)
    matches, unmatched_zones, unmatched_indices = utils.match_zones_to_polygons(
        [zone], [square]
    )
    assert matches == [(zone, 0)]
    assert unmatched_zones == []
    assert unmatched_indices == []


def test_match_zones_to_polygons_no_source_polygon_is_unmatched():
    zone = DummyZone(pk=1, source_polygon=None)
    square = [[0, 0], [10, 0], [10, 10], [0, 10]]
    matches, unmatched_zones, unmatched_indices = utils.match_zones_to_polygons(
        [zone], [square]
    )
    assert matches == []
    assert unmatched_zones == [zone]
    assert unmatched_indices == [0]


def test_compute_scale_fits_within_canvas():
    polygons = [[[0, 0], [100, 0], [100, 100], [0, 100]]]
    scale = utils._compute_scale(polygons, width_px=200, height_px=200)
    assert scale == 200 / 100 * 0.9


def test_compute_transform_centers_polygon_on_canvas():
    polygons = [[[0, 0], [100, 0], [100, 100], [0, 100]]]
    transform = utils.compute_transform(polygons, width_px=200, height_px=200)
    assert transform["min_x"] == 0
    assert transform["min_y"] == 0
    assert transform["scale"] > 0
    assert transform["offset_x"] > 0
    assert transform["offset_y"] > 0


def test_normalize_polygons_flips_y_axis():
    polygons = [[[0, 0], [100, 0], [100, 100], [0, 100]]]
    normalized = utils.normalize_polygons(polygons, width_px=200, height_px=200)
    # DXF is Y-up, canvas is Y-down: the DXF-bottom point (y=0) must land at
    # the larger pixel-y (closer to the bottom of the canvas).
    ys = [p[1] for p in normalized[0]]
    bottom_dxf_point_py = normalized[0][0][1]
    top_dxf_point_py = normalized[0][2][1]
    assert bottom_dxf_point_py > top_dxf_point_py
    assert max(ys) <= 200


def test_normalize_polygons_empty_input():
    assert utils.normalize_polygons([], width_px=200, height_px=200) == []


def test_pixel_to_dxf_roundtrip_with_normalize_polygons():
    polygons = [[[10, 20], [110, 20], [110, 120], [10, 120]]]
    width_px, height_px = 200, 200
    transform = utils.compute_transform(polygons, width_px, height_px)
    normalized = utils.normalize_polygons(polygons, width_px, height_px)

    for (orig_x, orig_y), (px, py) in zip(polygons[0], normalized[0]):
        x_dxf, y_dxf = utils.pixel_to_dxf(px, py, transform, height_px)
        assert x_dxf == pytest.approx(orig_x, abs=0.5)
        assert y_dxf == pytest.approx(orig_y, abs=0.5)


def test_normalize_strokes_preserves_closed_flag():
    strokes = [
        {"points": [[0, 0], [10, 0], [10, 10], [0, 10]], "closed": True},
        {"points": [[0, 0], [10, 0]], "closed": False},
    ]
    normalized = utils.normalize_strokes(strokes, width_px=200, height_px=200)
    assert [s["closed"] for s in normalized] == [True, False]
    assert len(normalized[0]["points"]) == 4
    assert len(normalized[1]["points"]) == 2


def test_normalize_strokes_empty_input():
    assert utils.normalize_strokes([], width_px=200, height_px=200) == []
