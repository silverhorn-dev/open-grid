# Erkennungsmodelle fuer den Nacktbild-Filter

Optionale Modelle, die der Router selbst ausliefert (`server/nudity-model.js`, Board T3). Aktiv wird
eins nur ueber `NUDITY_MODEL`; sonst erscheinen sie nur auf der Testseite im Debug-Modus.

| Ordner | Modell | Lizenz | Herkunft |
|---|---|---|---|
| `bumble/` | Bumble Private Detector, TF.js-Graph-Modell, uint8 (~51 MB) | Apache-2.0 (`bumble/LICENSE`) | https://github.com/bumble-tech/private-detector, `private_detector_with_frozen.zip`; umgewandelt mit `scripts/nudity-models/convert-bumble.py` (float16 -> float32, uint8-Quantisierung) |
| `nudenet/` | NudeNet 320n (ONNX) | AGPL-3.0 | nicht im Repository: das Docker-Image laedt es beim Bauen aus dem PyPI-Paket `nudenet` 3.4.2 (feste Pruefsumme); lokal mit `sh scripts/nudity-models/fetch.sh --dir models nudenet` |

Ein Ordner gleichen Namens in `NUDITY_MODEL_DIR` (Daten-Volume) hat Vorrang.
