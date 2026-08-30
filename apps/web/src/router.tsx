import { createRootRoute, createRoute, createRouter, Outlet, useNavigate } from '@tanstack/react-router';
import { AdminDashboardPage } from './routes/admin/dashboard';
import { AdminLoginPage } from './routes/admin/login';
import { HomePage } from './routes/home';
import { InvitePage } from './routes/invite';
import { MyListPage } from './routes/my-list';

const rootRoute = createRootRoute({ component: Outlet });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: HomePage });

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/i/$token',
  component: () => {
    const { token } = inviteRoute.useParams();
    return <InvitePage token={token} />;
  },
});

const myListRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/b/$token',
  component: () => {
    const { token } = myListRoute.useParams();
    return <MyListPage token={token} />;
  },
});

const adminLoginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/g/$guildSlug/login',
  component: () => {
    const { guildSlug } = adminLoginRoute.useParams();
    const navigate = useNavigate();
    return <AdminLoginPage guildSlug={guildSlug} onLoggedIn={() => navigate({ to: '/admin' })} />;
  },
});

const adminDashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: AdminDashboardPage });

const routeTree = rootRoute.addChildren([indexRoute, inviteRoute, myListRoute, adminLoginRoute, adminDashboardRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
