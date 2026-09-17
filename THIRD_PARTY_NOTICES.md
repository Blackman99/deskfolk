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

## Package dependencies

JavaScript and Rust dependencies are recorded in `pnpm-lock.yaml` and `apps/desktop/src-tauri/Cargo.lock`. Their licenses remain applicable independently of Real Bot's license. This file records incorporated third-party source; it is not an exhaustive license inventory for a packaged binary. Before distributing binaries, review the exact bundled dependency versions and include their required notices.
