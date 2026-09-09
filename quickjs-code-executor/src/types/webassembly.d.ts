/**
 * `WebAssembly` is a real Node.js global (has been since Node 8) but its
 * typings live in TypeScript's `dom` lib, not `es2020` — and pulling in all
 * of `dom` for one class would shadow unrelated Node globals. This declares
 * just the surface `engine/quickjs.ts` actually uses: a fresh, size-capped
 * linear memory handed to the WASM module per execution.
 */
declare namespace WebAssembly {
  class Memory {
    constructor(descriptor: { initial: number; maximum?: number; shared?: boolean });
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
}
