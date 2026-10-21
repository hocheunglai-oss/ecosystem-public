import { useEffect, useState } from "react";
import { useAccess } from "../auth";
import { adminRequest } from "./adminApi";
import type { ContributionPeriod } from "./contributionActivity";
import type { FeedbackContributionSummary } from "../../shared/admin";

export type SharedFeedbackStatus = "loading" | "ready" | "unavailable";
type SharedFeedbackResult = {
  userId: string;
  period: ContributionPeriod;
  value: FeedbackContributionSummary | null;
  error: string;
};

/** Refresh after submissions and while visible; never persist another account's server records. */
export function useSharedFeedback(period: ContributionPeriod = "7d") {
  const { realUser } = useAccess();
  const [result, setResult] = useState<SharedFeedbackResult | null>(null);
  useEffect(() => {
    setResult(null);
    if (!realUser) return;
    let active = true,
      request: AbortController | undefined;
    const refresh = () => {
      if (document.hidden) return;
      request?.abort();
      const controller = new AbortController();
      request = controller;
      // A confirmed count remains usable during its refresh; after a failure,
      // show a pending total until a new authenticated response arrives.
      setResult((previous) => ({
        userId: realUser.id,
        period,
        value:
          previous?.userId === realUser.id && previous.period === period
            ? previous.value
            : null,
        error: "",
      }));
      void adminRequest<FeedbackContributionSummary>(
        `feedback/contributions?period=${period}`,
        undefined,
        controller.signal,
      )
        .then((value) => {
          if (active && !controller.signal.aborted)
            setResult({ userId: realUser.id, period, value, error: "" });
        })
        .catch(() => {
          if (active && !controller.signal.aborted)
            setResult({
              userId: realUser.id,
              period,
              value: null,
              error: "SHARED FEEDBACK COUNT UNAVAILABLE",
            });
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("eco-feedback-updated", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      active = false;
      request?.abort();
      window.clearInterval(timer);
      window.removeEventListener("eco-feedback-updated", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [realUser?.id, period]);
  const current =
    result?.userId === realUser?.id && result?.period === period
      ? result
      : null;
  const status: SharedFeedbackStatus = current?.value
    ? "ready"
    : current?.error
      ? "unavailable"
      : "loading";
  return {
    summary: current?.value ?? null,
    error: current?.error ?? "",
    status,
    loading: status === "loading",
  };
}
