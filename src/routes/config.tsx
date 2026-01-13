import AuthLogin from "../pages/auth/AuthLogin"
import AuthSignUp from "../pages/auth/AuthSignUp"
import DashboardPage from "../pages/dashboard/DashboardPage"
import DashboardOverview from "../pages/dashboard/DashboardOverview"
import SettingsView from "../pages/dashboard/SettingsView"
import ProfileView from "../pages/dashboard/ProfileView"
import ArenaView from "../pages/dashboard/ArenaView"
import ArenaLobbyView from "../pages/dashboard/ArenaLobbyView"
import GamePlayView from "../pages/dashboard/GamePlayView"
import TournamentsView from "../pages/dashboard/TournamentsView"
import TournamentDetailView from "../pages/dashboard/TournamentDetailView"
import ClanView from "../pages/dashboard/ClanView"
import Home from "../pages/home/HomePage"
import RankingView from "../pages/dashboard/RankingView"
import PaymentView from "../pages/dashboard/PaymentView"
import TournamentMatchView from "../pages/dashboard/TournamentMatchView"
import NotFoundPage from "../pages/error/NotFoundPage"
import { ProtectedRoute, GuestRoute } from "../components/auth/AuthGuard"

export const routes = [
  {
    path: "/",
    element: () => (
      <GuestRoute>
        <Home />
      </GuestRoute>
    ),
  },
  {
    path: "/login",
    element: () => (
      <GuestRoute>
        <AuthLogin />
      </GuestRoute>
    ),
  },
  {
    path: "/signup",
    element: () => (
      <GuestRoute>
        <AuthSignUp />
      </GuestRoute>
    ),
  },
  {
    path: "/dashboard",
    element: () => (
      <ProtectedRoute>
        <DashboardPage />
      </ProtectedRoute>
    ),
    children: [
      {
        path: "",
        element: DashboardOverview,
      },
      {
        path: "profile",
        element: ProfileView,
      },
      {
        path: "settings",
        element: SettingsView,
      },
      {
        path: "arena", 
        element: ArenaView, 
      },
      {
        path: "arena/lobby",
        element: ArenaLobbyView,
      },
      {
        path: "tournaments", 
        element: TournamentsView,
      },
      {
        path: "tournaments/:id",
        element: TournamentDetailView,
        children: [
          { path: "", element: () => null },
          { path: "overview", element: () => null },
          { path: "bracket", element: () => null },
          { path: "clans", element: () => null },
          { path: "match", element: () => null },
        ]
      },
      {
        path: "clan", 
        element: ClanView,
        children: [
          { path: "", element: () => null }, // Default handled by parent logic
          { path: "explore", element: () => null },
        ]
      },
      {
        path: "ranking", 
        element: RankingView,
      },
      {
        path: "payment",
        element: PaymentView,
      }
    ]
  },
  {
    path: "/tournament-match/:matchId",
    element: () => (
      <ProtectedRoute>
        <TournamentMatchView />
      </ProtectedRoute>
    ),
  },
  {
    path: "/gameplay",
    element: GamePlayView,
  },
  {
    path: "*",
    element: NotFoundPage,
  },
]
