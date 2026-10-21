import { uppercaseText } from "./lib/uppercase";
import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  Flag,
  Plus,
  Target,
} from "lucide-react";
import { useDemo } from "./store";
import {
  currentMonth,
  monthlyStats,
  reportingMonth,
  actors,
} from "./lib/model";
import { Empty, Progress, Status, money, number } from "./ui";
import type { OpenModal, Page } from "./types";
import { MarineWorld } from "./MarineWorld";
export default function HomePage({
  open,
  go,
  motionEnabled,
}: {
  open: OpenModal;
  go: (p: Page) => void;
  motionEnabled: boolean;
}) {
  const { state, actor, notify } = useDemo();
  const month = currentMonth();
  const monthName = new Date().toLocaleDateString("en-GB", {
    month: "long",
    timeZone: "Asia/Hong_Kong",
  });
  const own = actor.role === "manager" ? "otto" : actor.id;
  const stats = monthlyStats(state, own, month);
  const goal = state.goals.find((g) => g.owner === own && g.month === month);
  const volumePercent = goal?.volume ? (stats.volume / goal.volume) * 100 : 0;
  const profitPercent = goal?.profit ? (stats.profit / goal.profit) * 100 : 0;
  const contributionPort =
    state.ports.find((p) => p.id === "port-singapore") || state.ports[0];
  const [missionMembers, setMissionMembers] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("ecosystem.mission") || "[]");
    } catch {
      return [];
    }
  });
  const memberKey = `${month}:${actor.id}`;
  const joined =
    Array.isArray(missionMembers) && missionMembers.includes(memberKey);
  const reviewedPorts = new Set(
    state.contributions
      .filter(
        (c) =>
          c.targetType === "port" &&
          c.status === "approved" &&
          c.reviewedAt &&
          reportingMonth(c.reviewedAt) === month,
      )
      .map((c) => c.targetId),
  );
  const requests = state.requests.filter((r) => r.status === "pending");
  const contributions = state.contributions.filter(
    (c) => c.status === "pending",
  );
  const active = state.enquiries.filter(
    (e) =>
      ["draft", "sent"].includes(e.status) &&
      (actor.role !== "trader" || e.owner === actor.id),
  );
  const recent = [...state.contributions]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  function joinMission() {
    const next = [
      ...(Array.isArray(missionMembers) ? missionMembers : []),
      memberKey,
    ];
    setMissionMembers(next);
    try {
      localStorage.setItem("ecosystem.mission", JSON.stringify(next));
    } catch {
      /* Available for this visit. */
    }
    notify(
      "You're on board. Share a useful port update to move the mission forward.",
    );
  }
  return (
    <>
      <section className="ocean-world" aria-label="Your maritime world">
        <MarineWorld motionEnabled={motionEnabled} />
        <div className="ocean-shade" />
        <div className="world-copy">
          <div className="world-eyebrow">
            <span className="live-spark" /> YOUR WORLD. OUR ADVANTAGE.
          </div>
          <h1>
            MAKE WAVES,
            <br />
            <em>{actor.name.split(" ")[0]}.</em>
          </h1>
          <p>
            {actor.role === "trader"
              ? "Every fixture moves you forward.\nEvery insight brings us closer."
              : actor.role === "credit"
                ? "Keep good business moving.\nGive every decision a clear direction."
                : "Turn individual knowledge\ninto a shared advantage."}
          </p>
          <button
            className="world-primary"
            onClick={() =>
              go(
                actor.role === "trader"
                  ? "enquiry"
                  : actor.role === "credit"
                    ? "credit"
                    : "management",
              )
            }
          >
            <span>
              {actor.role === "trader"
                ? "New enquiry"
                : actor.role === "credit"
                  ? "Review credit"
                  : "Review contributions"}
            </span>
            <ArrowUpRight size={23} />
          </button>
          <a
            className="world-secondary"
            href="#shared-mission"
            onClick={(e) => {
              e.preventDefault();
              document.getElementById("shared-mission")?.scrollIntoView({
                behavior: motionEnabled ? "smooth" : "instant",
                block: "center",
              });
            }}
          >
            Explore the group mission <ArrowRight size={15} />
          </a>
        </div>
        <span className="world-caption">ONE CONNECTED WORLD</span>
        <div className="voyage-hud">
          <div className="voyage-label">
            <span>
              {monthName.toUpperCase()} /{" "}
              {actor.role === "credit"
                ? "CREDIT DESK"
                : actor.role === "manager"
                  ? "TEST VOYAGE"
                  : "YOUR VOYAGE"}
            </span>
            <strong>
              {actor.role === "credit" ? "CLEAR THE WAY." : "FIND YOUR PACE."}
            </strong>
            {actor.role === "trader" && (
              <button onClick={() => open({ type: "resources" })}>
                <Target size={14} /> Edit targets
              </button>
            )}
          </div>
          <div className="journey-numbers voyage-numbers">
            {actor.role !== "credit" ? (
              <>
                <div>
                  <span>Booked volume</span>
                  <strong>
                    {number(stats.volume)} <small>MT</small>
                  </strong>
                  <Progress
                    value={volumePercent}
                    label="Monthly volume target"
                  />
                  <small>
                    {goal?.volume
                      ? `${Math.round(volumePercent)}% of ${number(goal.volume)} MT`
                      : "No target set · optional"}
                  </small>
                </div>
                <div>
                  <span>Booked profit · USD</span>
                  <strong>{money(stats.profit)}</strong>
                  <Progress
                    value={profitPercent}
                    label="Monthly profit target"
                  />
                  <small>
                    {goal?.profit
                      ? `${Math.round(profitPercent)}% of ${money(goal.profit)}`
                      : "No target set · optional"}
                  </small>
                </div>
              </>
            ) : (
              <>
                <div>
                  <span>Awaiting review</span>
                  <strong>{requests.length}</strong>
                  <small>Decisions waiting for your expertise</small>
                </div>
                <div>
                  <span>Requested credit · USD</span>
                  <strong>
                    {money(
                      requests.reduce((sum, r) => sum + r.amount, 0),
                      true,
                    )}
                  </strong>
                  <small>Amount, terms and rationale recorded</small>
                </div>
              </>
            )}
          </div>
          <button
            className="voyage-next"
            onClick={() => go(actor.role === "credit" ? "credit" : "records")}
          >
            <span>
              {actor.role === "credit"
                ? "Open inbox"
                : `${stats.fixtures} fixtures this month`}
            </span>
            <ArrowRight size={22} />
          </button>
        </div>
      </section>
      <section
        className="shared-mission"
        id="shared-mission"
        aria-labelledby="mission-title"
      >
        <div className="mission-intro">
          <span className="section-label">
            <Flag size={15} /> THE GROUP MISSION / {monthName.toUpperCase()}
          </span>
          <h2 id="mission-title">
            8 PORTS.
            <br />
            ONE SHARED ADVANTAGE.
          </h2>
          <p>
            Local knowledge travels further when we share it.
            <br />
            Help refresh eight ports with reviewed, useful updates.
          </p>
        </div>
        <div className="mission-progress">
          <div className="mission-count">
            <strong>
              {reviewedPorts.size}
              <span>/ 8</span>
            </strong>
            <span>
              ports refreshed
              <br />
              by the group
            </span>
          </div>
          <div
            className="mission-stops"
            aria-label={`${reviewedPorts.size} of 8 ports refreshed`}
          >
            {state.ports.slice(0, 8).map((p, i) => (
              <button
                key={p.id}
                className={reviewedPorts.has(p.id) ? "complete" : ""}
                aria-label={`${p.name}: ${reviewedPorts.has(p.id) ? "refreshed" : "needs an update"}`}
                title={uppercaseText(p.name)}
                onClick={() => {
                  location.hash = `/ports?port=${p.id}`;
                }}
              >
                {reviewedPorts.has(p.id) ? (
                  <Check size={15} />
                ) : (
                  String(i + 1).padStart(2, "0")
                )}
              </button>
            ))}
          </div>
        </div>
        <div className="mission-actions">
          {joined ? (
            <span className="mission-joined">
              <Check size={16} /> You’re on board
            </span>
          ) : (
            <button className="mission-join" onClick={joinMission}>
              Join the mission <ArrowRight size={19} />
            </button>
          )}
          <button
            className="mission-share"
            onClick={() =>
              open({
                type: "contribute",
                targetType: "port",
                targetId: contributionPort?.id || "port-singapore",
              })
            }
          >
            Share local knowledge <Plus size={17} />
          </button>
          <small>
            Reviewed by management.
            <br />
            Your knowledge makes the difference.
          </small>
        </div>
      </section>
      <div className="world-lower">
        <section className="next-moves">
          <div className="editorial-heading">
            <span className="section-label">KEEP THE MOMENTUM</span>
            <h2>Your next move.</h2>
          </div>
          {[
            {
              n: "01",
              title: "Turn an enquiry into a fixture.",
              detail: `${active.length} active enquiries · buyer, port and credit in one flow`,
              page: "enquiry" as Page,
            },
            {
              n: "02",
              title: "Give good business the green light.",
              detail: `${requests.length} credit requests waiting for a decision`,
              page: "credit" as Page,
            },
            {
              n: "03",
              title: "Make what you know count.",
              detail: `${contributions.length} contributions awaiting review`,
              page: "management" as Page,
            },
          ].map((a) => (
            <button className="next-move" key={a.n} onClick={() => go(a.page)}>
              <span className="move-number">{a.n}</span>
              <span>
                <strong>{a.title}</strong>
                <small>{a.detail}</small>
              </span>
              <ArrowUpRight size={23} />
            </button>
          ))}
        </section>
        <section className="crew-feed">
          <div className="editorial-heading">
            <span className="section-label">KNOWLEDGE IN MOTION</span>
            <h2>From the crew.</h2>
          </div>
          {recent.length ? (
            recent.map((c) => {
              const author = actors.find((a) => a.id === c.author);
              return (
                <button
                  key={c.id}
                  className="crew-story"
                  onClick={() =>
                    open({ type: "review-contribution", id: c.id })
                  }
                >
                  <span className="crew-avatar">
                    {author?.name
                      .split(" ")
                      .map((n) => n[0])
                      .join("") || "EC"}
                  </span>
                  <span>
                    <strong>{c.title}</strong>
                    <small>
                      {author?.name || c.author} ·{" "}
                      {c.targetType === "case-study"
                        ? "Case study"
                        : c.targetType === "buyer-competition"
                          ? "Competition"
                          : "Local intelligence"}
                    </small>
                    <span className={`crew-story-state ${c.status}`}>
                      {c.status === "approved"
                        ? c.targetType === "buyer-competition" ? "Published" : "Accepted · shared with the group"
                        : c.status === "pending"
                          ? "Submitted · awaiting review"
                          : "Reviewed · declined"}
                    </span>
                  </span>
                  <ArrowUpRight size={17} />
                </button>
              );
            })
          ) : (
            <Empty title="Your next insight could start something.">
              Share a port or customer update.
            </Empty>
          )}
          <button
            className="text-button"
            onClick={() =>
              open({
                type: "contribute",
                targetType: "case-study",
                targetId: "group",
              })
            }
          >
            Share a case study <Plus size={16} />
          </button>
        </section>
        <section className="voyage-log">
          <div className="editorial-heading">
            <div>
              <span className="section-label">ON YOUR RADAR</span>
              <h2>Business in motion.</h2>
            </div>
            <button className="text-button" onClick={() => go("enquiry")}>
              View enquiries <ArrowRight size={16} />
            </button>
          </div>
          <div className="voyage-log-list">
            {active.slice(0, 4).map((e) => (
              <button
                key={e.id}
                className="voyage-log-row"
                onClick={() => open({ type: "enquiry-detail", id: e.id })}
              >
                <span>
                  <strong>{e.vessel || "New enquiry"}</strong>
                  <small>
                    {state.companies.find((c) => c.id === e.buyerId)?.name ||
                      "Buyer to confirm"}
                  </small>
                </span>
                <span>
                  {state.ports.find((p) => p.id === e.portId)?.name ||
                    "Port to confirm"}
                </span>
                <span>{number(e.quantity)} MT</span>
                <Status value={e.status} />
                <ArrowUpRight size={18} />
              </button>
            ))}
            {!active.length && <Empty title="Ready for your next enquiry." />}
          </div>
        </section>
      </div>
    </>
  );
}
