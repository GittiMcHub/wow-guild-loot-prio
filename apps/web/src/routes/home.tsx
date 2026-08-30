export function HomePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 p-4 text-center">
      <h1 className="text-3xl font-semibold">Guild Loot Priority System</h1>
      <p className="max-w-md text-zinc-400">
        Players use their personal invite (<code>/i/&lt;token&gt;</code>) or list link (<code>/b/&lt;token&gt;</code>).
        Loot masters sign in at <code>/g/&lt;guild-slug&gt;/login</code>.
      </p>
    </div>
  );
}
