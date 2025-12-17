import { RequireAuth } from '../../components/RequireAuth';
import { AppNav } from '../../components/AppNav';

export default function AppLayout(props: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <div className="min-h-screen bg-zinc-50">
        <AppNav />
        <div className="mx-auto max-w-6xl px-6 py-8">{props.children}</div>
      </div>
    </RequireAuth>
  );
}
