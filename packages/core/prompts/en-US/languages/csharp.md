## C# Standards

- Follow .NET version, nullable settings, layers and naming. Express public constraints with types and existing validation; avoid broad catches hiding failures.
- Propagate CancellationToken. Avoid Result/Wait blocking async flows. Use using/await using and own background Task lifecycles.
- Check transaction/concurrent updates and reuse dependency injection. Run dotnet test with related project/case filters, not the full solution.
