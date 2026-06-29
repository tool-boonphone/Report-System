import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SectionProvider } from "./contexts/SectionContext";
import { NavActionsProvider } from "./contexts/NavActionsContext";
import { DebtCacheProvider } from "./contexts/DebtCacheContext";
import { IncomeCacheProvider } from "./contexts/IncomeCacheContext";
import Login from "./pages/Login";
import SelectSection from "./pages/SelectSection";
import ChangePassword from "./pages/ChangePassword";
import Contracts from "./pages/Contracts";
import BadDebtSummary from "./pages/BadDebtSummary";
import DebtReport from "./pages/DebtReport";
import DebtSummary from "./pages/DebtSummary";
import DebtOverview from "./pages/DebtOverview";
import MonthlySummary from "./pages/MonthlySummary";
import SuspectedBadDebt from "./pages/SuspectedBadDebt";
import WatchGroup from "./pages/WatchGroup";
import NewCustomerWatch from "./pages/NewCustomerWatch";
import DataLoadingScreen from "./pages/DataLoadingScreen";
import UsersSettings from "./pages/settings/Users";
import GroupsSettings from "./pages/settings/Groups";
import Income from "./pages/Income";
import Expense from "./pages/Expense";
import Notice from "./pages/Notice";

function Router() {
  return (
    <Switch>
      <Route path="/" component={() => <Redirect to="/contracts" />} />
      <Route path="/login" component={Login} />
      <Route path="/select-section" component={SelectSection} />
      <Route path="/change-password" component={ChangePassword} />
      <Route path="/data-loading" component={DataLoadingScreen} />
      <Route path="/contracts" component={Contracts} />
      <Route path="/debt-overview" component={DebtOverview} />
      <Route path="/debt-summary" component={DebtSummary} />
      <Route path="/debt-report" component={DebtReport} />
      <Route path="/new-customer-watch" component={NewCustomerWatch} />
      <Route path="/watch-group" component={WatchGroup} />
      <Route path="/suspected-bad-debt" component={SuspectedBadDebt} />
      <Route path="/bad-debt-summary" component={BadDebtSummary} />
      <Route path="/monthly-summary" component={MonthlySummary} />
      <Route path="/income" component={Income} />
      <Route path="/expense" component={Expense} />
      <Route path="/notice" component={Notice} />
      <Route path="/settings/users" component={UsersSettings} />
      <Route path="/settings/groups" component={GroupsSettings} />
      <Route path="/404" component={NotFound} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <SectionProvider>
          <DebtCacheProvider>
          <IncomeCacheProvider>
          <NavActionsProvider>
            <TooltipProvider>
              <Toaster richColors position="top-right" />
              <Router />
            </TooltipProvider>
          </NavActionsProvider>
          </IncomeCacheProvider>
          </DebtCacheProvider>
        </SectionProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
