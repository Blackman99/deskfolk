# Third-party notices

Real Bot's own code is licensed under the [MIT License](LICENSE). Third-party components retain their respective licenses.

## Boring Avatars

The avatar generator in `packages/protocol/src/boring-avatars.ts` adapts algorithms and SVG designs from [Boring Avatars](https://github.com/boringdesigners/boring-avatars), including its utilities and avatar variants, into a TypeScript SVG-string implementation. The upstream [MIT license](https://github.com/boringdesigners/boring-avatars/blob/master/LICENSE) is reproduced below.

```text
MIT License

Copyright (c) 2021 boringdesigners

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Noise test vectors

`packages/remote/test/fixtures/cacophony-ik.json` is the IK/25519/ChaChaPoly/BLAKE2s entry from [Cacophony](https://github.com/centromere/cacophony), commit `8ee9d41e34a1a596cfa3ab12aa4069ff87dc1247`, `vectors/cacophony.txt`. It is listed in the [official Noise test-vector registry](https://github.com/noiseprotocol/noise_wiki/wiki/Test-vectors). The source file SHA-256 is `3bde7c09a6f349ee11c825c50fcc02649f8f02a47c857a459206b357f9386cae`. Cacophony is released under the Unlicense:

```text
This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <http://unlicense.org>
```

`packages/remote/test/fixtures/noise-c-ik.json` extracts the same suite from [noise-c](https://github.com/rweather/noise-c), commit `cfe25410979a87391bb9ac8d4d4bef64e9f268c6`, `tests/vector/noise-c-basic.txt`, also listed in the official registry. Source SHA-256: `e826749cf90efda26be85410381f4b1f75552c61c7c0dcad7f9ffb4d639e4e45`. Its MIT license:

```text
Copyright (C) 2016 Southern Storm Software, Pty Ltd.

Permission is hereby granted, free of charge, to any person obtaining a
copy of this software and associated documentation files (the "Software"),
to deal in the Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, sublicense,
and/or sell copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included
in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

Only JSON formatting/filtering was changed; vector values are unmodified. Their private keys are published test material, not application credentials. The independent Rust harness links `snow` 0.10.0 (Apache-2.0 OR MIT) and `ed25519-dalek` 2.2.0 (BSD-3-Clause); its exact transitive versions are locked in `packages/remote/test/snow/Cargo.lock`. Runtime Noble dependencies retain their MIT licenses; cborg 4.3.2 is Apache-2.0. Dependency audit history is not an audit of this integration; see [the security prototype contract](docs/remote-protocol.md).

## Package dependencies

JavaScript and Rust dependencies are recorded in `pnpm-lock.yaml` and `apps/desktop/src-tauri/Cargo.lock`. Their licenses remain applicable independently of Real Bot's license. This file records incorporated third-party source; it is not an exhaustive license inventory for a packaged binary. Before distributing binaries, review the exact bundled dependency versions and include their required notices.
