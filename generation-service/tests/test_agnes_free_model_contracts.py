import pytest

from generation.providers.providers import (
    build_agnes_image_payload,
    build_agnes_video_payload,
    build_agnes_video_poll_url,
)


def test_image_reference_is_nested_in_extra_body() -> None:
    payload = build_agnes_image_payload(
        {
            "prompt": "保留瓶身，改成雨夜背景",
            "size": "2K",
            "ratio": "9:16",
            "referenceImages": ["https://cdn.test/bottle.png"],
        }
    )
    assert payload == {
        "model": "agnes-image-2.5-flash",
        "prompt": "保留瓶身，改成雨夜背景",
        "size": "2K",
        "ratio": "9:16",
        "extra_body": {"image": ["https://cdn.test/bottle.png"], "response_format": "url"},
    }


def test_image_21_compatibility_alias_resolves_to_image_25() -> None:
    payload = build_agnes_image_payload({"model": "agnes-image-2.1-flash", "prompt": "雨夜咖啡杯"})
    assert payload["model"] == "agnes-image-2.5-flash"


def test_image_reference_strips_data_uri_prefix_before_sending_to_agnes() -> None:
    raw_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlQY6sAAAAASUVORK5CYII="
    payload = build_agnes_image_payload(
        {"prompt": "保留画面主体", "referenceImages": [f"data:image/png;base64,{raw_png}"]}
    )

    assert payload["extra_body"]["image"] == [raw_png]


@pytest.mark.parametrize(
    ("params", "mode"),
    [
        ({"prompt": "雨夜街道", "duration": 5}, "text"),
        ({"prompt": "转身", "firstFrameUrl": "https://cdn/f.png"}, "keyframe"),
        ({"prompt": "参考角色", "referenceImages": ["https://cdn/r.png"]}, "reference"),
    ],
)
def test_video_mode_and_flash_limits(params: dict, mode: str) -> None:
    payload = build_agnes_video_payload(params)
    assert payload["model"] == "agnes-video-2.5-flash"
    assert payload["mode"] == mode
    assert payload["size"] == "720P"
    assert payload["seconds"] == "5"
    assert payload["n"] == 1
    assert "width" not in payload
    assert "height" not in payload
    assert "num_frames" not in payload


@pytest.mark.parametrize("seconds", [4, 12])
def test_video_accepts_flash_duration_boundaries(seconds: int) -> None:
    assert build_agnes_video_payload({"prompt": "雨夜", "duration": seconds})["seconds"] == str(seconds)


@pytest.mark.parametrize("seconds", [3, 13])
def test_video_rejects_duration_outside_flash_limits(seconds: int) -> None:
    with pytest.raises(ValueError, match="4.*12"):
        build_agnes_video_payload({"prompt": "雨夜", "duration": seconds})


def test_video_rejects_more_than_five_reference_images() -> None:
    with pytest.raises(ValueError, match="5"):
        build_agnes_video_payload(
            {"prompt": "角色", "referenceImages": [f"https://cdn/{i}.png" for i in range(6)]}
        )


def test_video_poll_url_contains_video_id_and_model_name() -> None:
    url = build_agnes_video_poll_url("video-1", "agnes-video-2.5-flash")
    assert "video_id=video-1" in url
    assert "model_name=agnes-video-2.5-flash" in url
