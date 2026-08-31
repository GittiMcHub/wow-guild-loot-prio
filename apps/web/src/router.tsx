import { createRootRoute, createRoute, createRouter, Outlet, useNavigate } from '@tanstack/react-router';
import { AdminDashboardPage } from './routes/admin/dashboard';
import { AdminLoginPage } from './routes/admin/login';
import { HomePage } from './routes/home';
import { InvitePage } from './routes/invite';
import { ListBuilderPage } from './routes/list-builder';

const rootRoute = createRootRoute({ component: Outlet });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });

const inviteRoute = createRoute({ getParentRoute: () => rootRoute, path: '/i/$token', component: InviteRouteComponent });
function InviteRouteComponent() {
  const { token } = inviteRoute.useParams();
  return <InvitePage token={token} />;
}

const myListRoute = createRoute({ getParentRoute: () => rootRoute, path: '/b/$token', component: MyListRouteComponent });
function MyListRouteComponent() {
  const { token } = myListRoute.useParams();
  return <ListBuilderPage token={token} />;
}

const adminLoginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/g/$guildSlug/login', component: AdminLoginRouteComponent });
function AdminLoginRouteComponent() {
  const { guildSlug } = adminLoginRoute.useParams();
  const navigate = useNavigate();
  return <AdminLoginPage guildSlug={guildSlug} onLoggedIn={() => navigate({ to: '/admin' })} />;
}

const adminDashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: AdminDashboardPage });

const routeTree = rootRoute.addChildren([indexRoute, inviteRoute, myListRoute, adminLoginRoute, adminDashboardRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
