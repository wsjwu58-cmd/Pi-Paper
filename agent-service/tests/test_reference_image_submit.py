# -*- coding: utf-8 -*-
from agent.domain.prompt_builder import prompt_for_image_then_video
from agent.tools.registry import (
    _merge_reference_params,
    _preserve_reference_fields,
    _reinforce_prompt_with_reference,
)


def test_preserve_reference_fields_after_video_rails():
    before = {
        "prompt": "move slowly",
        "firstFrameUrl": "http://x/a.jpg",
        "imageUrl": "http://x/a.jpg",
        "image": "http://x/a.jpg",
        "referenceImages": ["http://x/a.jpg"],
        "referenceUrls": ["http://x/a.jpg"],
        "duration": 5,
    }
    rails = {
        "prompt": "move slowly",
        "count": 1,
        "duration": 5,
        "ratio": "16:9",
        "resolution": "1280x720",
        "generate_audio": True,
        "model": "agnes-video-v2.0",
    }
    merged = _preserve_reference_fields(before, rails)
    assert merged["firstFrameUrl"] == "http://x/a.jpg"
    assert merged["imageUrl"] == "http://x/a.jpg"
    assert merged["referenceImages"] == ["http://x/a.jpg"]
    assert merged["model"] == "agnes-video-v2.0"


def test_merge_reference_params_appends_lists():
    base = {"referenceUrls": ["http://a"], "prompt": "p"}
    refs = {"referenceUrls": ["http://b", "http://a"], "firstFrameUrl": "http://a"}
    out = _merge_reference_params(base, refs)
    assert out["referenceUrls"] == ["http://a", "http://b"]
    assert out["firstFrameUrl"] == "http://a"


def test_reference_media_does_not_rewrite_video_prompt():
    out = _reinforce_prompt_with_reference(
        {"prompt": "pan left", "firstFrameUrl": "http://x/a.jpg", "model": "agnes-video-v2.0"},
        "video",
    )
    assert out["prompt"] == "pan left"


def test_reference_media_does_not_rewrite_image_prompt():
    out = _reinforce_prompt_with_reference(
        {"prompt": "cinematic", "referenceImages": ["http://x/a.jpg"], "model": "agnes-image-2.5-flash"},
        "image",
    )
    assert out["prompt"] == "cinematic"


def test_image_then_video_prompt_stresses_first_frame_fidelity():
    img, vid = prompt_for_image_then_video("cat opens door", duration=5)
    assert img
    assert len(vid) > 10
