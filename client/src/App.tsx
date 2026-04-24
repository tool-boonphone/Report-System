import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/NotFound";
import { Redirect, Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { ThemeProvider } from "./contexts/ThemeContext";
import { SectionProvider } from "./contexts/SectionContext";
import { NavActionsProvider } from "./contexts/NavActionsContext";
import Login from "./pages/Login";
import SelectSection from "./pages/SelectSection";
import ChangePassword from "./pages/ChangePassword";
import Contracts from "./pages/Contracts";
import BadDebtSummary from "./pages/BadDebtSummary";
import DebtReport from "./pages/DebtReport";
import UsersSettings from "./pages/settings/Users";
import GroupsSettings from "./pages/settings/Groups";

function Router() {
  return (
    <Switch>
      <Route path="/" component={() => <Redirect to="/contracts" />} />
      <Route path="/login" component={Login} />
      <Route path="/select-section" component={SelectSection} />
      <Route path="/change-password" component={ChangePassword} />
      <Route path="/contracts" component={Contracts} />
      <Route path="/debt-report" component={DebtReport} />
      <Route path="/bad-debt-summary" component={BadDebtSummary} />
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
          <NavActionsProvider>
            <TooltipProvider>
              <Toaster richColors position="top-right" />
              <Router />
            </TooltipProvider>
          </NavActionsProvider>
        </SectionProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
