## JavaScript Standards

- Preserve ESM/CommonJS, target environment and lint conventions. Use clear data structures and established validation for external inputs; follow existing JSDoc and do not migrate languages incidentally.
- Propagate async failures and cancellation. Remove listeners, close streams and clear timers. Avoid implicit globals, floating Promises and business logic relying on object-key order.
- Prefer exact local edits and existing helpers. Change dependencies/lockfiles only as required. Run this Task's related unit tests, not full scripts by default.
