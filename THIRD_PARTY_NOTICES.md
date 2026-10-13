# Third-party notices

Alexandria retains its existing authorship and license. No ai-memory Rust implementation or pretrained model weights are bundled into this source tree.

Retrieval architecture and bounded authority experiments were informed by Fabio Akita's ai-memory, research source commit `b54dc77bfdbf4ead9e3b2b0ed7579039f9b8dbae` (MIT, Copyright 2026 Fabio Akita). Its license is preserved at `licenses/ai-memory-MIT.txt`. RRF JavaScript is an independent implementation of Cormack, Clarke and Buettcher, SIGIR 2009, https://doi.org/10.1145/1571941.1572114; source comments identify the algorithm. Original evaluation fixtures are synthetic Alexandria fixtures; retrieval metric formulas are standard definitions.

Optional trained runtime: Hugging Face Transformers.js 3.8.1 (Apache-2.0), https://github.com/huggingface/transformers.js/tree/3.8.1. ONNX Runtime is MIT, https://github.com/microsoft/onnxruntime/blob/main/LICENSE. These are optional package-manager dependencies; their distributed licenses remain with the packages.

Optional model: intfloat/multilingual-e5-small (MIT), source revision `614241f622f53c4eeff9890bdc4f31cfecc418b3`, https://huggingface.co/intfloat/multilingual-e5-small. ONNX conversion Xenova/multilingual-e5-small revision `761b726dd34fb83930e26aab4e9ac3899aa1fa78`, https://huggingface.co/Xenova/multilingual-e5-small. The explicit preparation CLI downloads only pinned public files and verifies SHA256; weights/cache stay local and ignored. Users should retain the original model license with any redistributed weights. The q8 download is about136MB; runtime memory depends on workload and is measured separately.
