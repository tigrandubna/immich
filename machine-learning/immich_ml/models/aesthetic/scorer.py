"""
Aesthetic-quality scorer (fork addition).

Wraps an ONNX-exported BEiT-style image classifier (cafeai/cafe_aesthetic by
default) and returns a single float in [0, 1] representing the model's
confidence that the image is "aesthetic". Used by the auto-trip prototype
to pick the best-looking shots from a burst.

The model file must live at the standard immich cache path
    /cache/aesthetic/<model-name>/scorer/model.onnx
The classifier expects 224x224 RGB normalised with mean=std=0.5 (BEiT default).
The first output dim is treated as the aesthetic class; we softmax and return
that class's probability. Other binary classifiers with reversed class order
will give an inverted score — easy to flip in the service layer if needed.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from immich_ml.models.base import InferenceModel
from immich_ml.models.transforms import decode_pil, normalize, resize_pil, to_numpy
from immich_ml.schemas import ModelTask, ModelType


_INPUT_SIZE = 224
# BEiT / cafe_aesthetic preprocess uses mean=std=0.5, not ImageNet.
_MEAN = np.array([0.5, 0.5, 0.5], dtype=np.float32)
_STD = np.array([0.5, 0.5, 0.5], dtype=np.float32)


class CafeAestheticScorer(InferenceModel):
    depends: list[Any] = []
    identity = (ModelType.SCORER, ModelTask.AESTHETIC)

    def _predict(self, inputs: Image.Image | bytes, **_: Any) -> float:
        image = decode_pil(inputs).convert("RGB")
        image = resize_pil(image, _INPUT_SIZE)
        # Center-crop to square 224×224.
        w, h = image.size
        left = max(0, (w - _INPUT_SIZE) // 2)
        top = max(0, (h - _INPUT_SIZE) // 2)
        image = image.crop((left, top, left + _INPUT_SIZE, top + _INPUT_SIZE))

        arr = to_numpy(image)
        arr = normalize(arr, _MEAN, _STD)
        # NCHW float32
        nchw: NDArray[np.float32] = np.expand_dims(arr.transpose(2, 0, 1), 0)

        input_name = self.session.get_inputs()[0].name
        outputs = self.session.run(None, {input_name: nchw})
        logits: NDArray[np.float32] = outputs[0][0]

        # Numerically-stable softmax over the 2 logits.
        e = np.exp(logits - logits.max())
        probs = e / e.sum()
        # cafe_aesthetic's id2label is {0: "aesthetic", 1: "not_aesthetic"} — the
        # "aesthetic" probability lives at index 0.
        return float(probs[0])

    def _download(self) -> None:
        # The cafe_aesthetic ONNX weights aren't hosted under immich-app/<name>
        # like the standard models. The download path is handled out-of-band by
        # scripts/fetch_aesthetic_model.py — if the cache file isn't present at
        # load time we raise a clear error pointing at that script rather than
        # silently failing.
        if not self.cached:
            raise FileNotFoundError(
                f"Aesthetic model not found at {self.model_path}. "
                "Run scripts/fetch_aesthetic_model.py inside the "
                "immich_machine_learning container to download and convert it."
            )
