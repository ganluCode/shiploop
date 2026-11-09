## C / C++ Standards

- Follow the language standard, compiler and build conventions. Make memory, handle and buffer ownership, lengths and lifetimes explicit. Prefer C++ RAII; avoid undefined behavior.
- Define data-race, atomic and lock boundaries. Never capture expired objects in callbacks/async I/O. Release resources on all failure paths.
- Reuse tests and diagnostics. Build/test only affected targets; use existing sanitizers on necessary local cases without starting heavyweight repository checks.
