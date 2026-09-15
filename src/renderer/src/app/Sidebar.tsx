import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ConvId, PresenceView } from "@shared/types";
import type { GroupView } from "@shared/bridge";
import { CHANNEL_NAME_MAX, normalizeChannelName } from "@shared/channelName";
import { STATUS_MAX } from "@shared/presenceStatus";
import { RETENTION, TEAM_CONV } from "@shared/constants";
import { materializeCalendar, occurrencesInRange, ymd } from "@shared/calendar";
import { useStore, selfOf } from "@/store";
import { Avatar, DeviceChip, identityHue } from "@/ui/atoms";
import { SectionLabel, Toggle, truncate } from "./chrome";
import {
  IconCalendar,
  IconGear,
  IconGitPull,
  IconLock,
  IconMore,
  IconPlus,
} from "./icons";
import { useBeamTarget, BeamLabel } from "./beam";
import { openDm, useDmMap } from "./dm";
import { countPreTombstonePeers } from "./outdatedPeers";
import { peopleRows } from "./peopleRows";
import { PersonLines } from "./PersonLines";
import { convNameMax, planRename } from "./renamePlan";
import { toast } from "./toasts";
import QuickSwitcher from "./QuickSwitcher";
import { ConfirmDialog, Dropdown, MenuItem, MenuNote } from "./ChannelMenu";
import { GroupDialog } from "./GroupDialog";
import { NotificationsBell, NotificationsPopover } from "./NotificationsPopover";

// Spec §2.2 — the sidebar: quick switcher, channels, DMs (beam drop targets),
// self footer with status popover. The team block lives in the titlebar row.

function ChannelRow({
  conv,
  name,
  active,
  unread,
  fixed,
  onClick,
}: {
  conv: ConvId;
  name: string;
  active: boolean;
  unread: number;
  fixed: boolean;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(name);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  // Feeds the delete-confirm warning below (older-build teammates who won't
  // see the tombstone) — cheap enough to keep memoized off `presence` alone.
  const presence = useStore((s) => s.presence);
  const outdatedPeers = useMemo(() => countPreTombstonePeers(presence), [presence]);

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  const hasUnread = unread > 0;
  const showTrigger = hover || menuOpen;

  async function submitRename() {
    // One rename decision for every surface (1.5): the row menu here, the
    // conversation header and the right rail all go through planRename, so a
    // change to the normalization or the home-channel refusal cannot reach two
    // of the three and leave this one behind.
    const plan = planRename({ kind: "channel", current: name, input: renameValue, fixed });
    setRenaming(false);
    if (plan.action === "refuse") {
      toast(plan.reason, "info");
      return;
    }
    if (plan.action !== "rename") return;
    try {
      await window.bridge.chat.renameChannel(conv, plan.name);
    } catch (err) {
      toast(
        `Could not rename #${name} — ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
    }
  }

  async function confirmDelete() {
    setBusy(true);
    try {
      await window.bridge.chat.deleteChannel(conv);
      setDeleteOpen(false);
    } catch (err) {
      toast(
        `Could not delete #${name} — ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
    } finally {
      setBusy(false);
    }
  }

  if (renaming) {
    return (
      <div style={{ padding: "2px 8px 2px 10px" }}>
        <input
          ref={renameRef}
          className="sem-input"
          style={{ height: 28, fontSize: 12 }}
          value={renameValue}
          maxLength={CHANNEL_NAME_MAX}
          aria-label={`Rename #${name}`}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={() => void submitRename()}
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div
      className="sem-row-hoverable"
      style={{ position: "relative" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        className="sem-row"
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        title={`#${name}`}
        aria-label={`Channel ${name}${hasUnread ? `, ${unread} unread` : ""}`}
        style={{
          position: "relative",
          width: "100%",
          height: 30,
          gap: 8,
          padding: "0 8px 0 10px",
          borderRadius: "var(--r-sm)",
          background: active ? "var(--accent-soft)" : undefined,
        }}
      >
        {active && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 0,
              top: 7,
              bottom: 7,
              width: 2,
              borderRadius: 2,
              background: "var(--accent)",
            }}
          />
        )}
        <span
          aria-hidden="true"
          style={{
            width: 14,
            textAlign: "center",
            fontWeight: 600,
            fontSize: 13,
            color: identityHue(name),
            filter: "saturate(0.6)",
            flexShrink: 0,
            userSelect: "none",
          }}
        >
          #
        </span>
        <span
          style={{
            ...truncate,
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: hasUnread ? 600 : 400,
            color: active || hasUnread ? "var(--text-1)" : "var(--text-2)",
            transition: "color var(--t-fast) var(--ease-standard)",
          }}
        >
          {name}
        </span>
        {!showTrigger && hasUnread && (
          <span className="sem-row-badge">
            <UnreadBadge count={unread} />
          </span>
        )}
      </button>

      <button
        className="sem-row sem-focus sem-row-trigger"
        data-open={menuOpen ? "1" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        title="Channel options"
        aria-label={`Options for #${name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={{
          position: "absolute",
          right: 6,
          top: 6,
          width: 18,
          height: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--r-xs)",
          color: "var(--text-3)",
        }}
      >
        <IconMore size={13} />
      </button>
      <Dropdown open={menuOpen} onClose={() => setMenuOpen(false)}>
        {fixed ? (
          <>
            <MenuItem disabled title="Home channel — can't be renamed or deleted">
              Rename…
            </MenuItem>
            <MenuItem disabled title="Home channel — can't be renamed or deleted">
              Delete…
            </MenuItem>
            <MenuNote>Home channel — can't be renamed or deleted.</MenuNote>
          </>
        ) : (
          <>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                setRenameValue(name);
                setRenaming(true);
              }}
            >
              Rename…
            </MenuItem>
            <MenuItem
              danger
              onClick={() => {
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
            >
              Delete…
            </MenuItem>
          </>
        )}
      </Dropdown>

      {deleteOpen && (
        <ConfirmDialog
          title={`Delete #${name}?`}
          message={
            <>
              {`Delete #${name} for everyone? Messages stay on the share until the next cleanup (about ${RETENTION.deletedConvGraceDays} days), then they're gone.`}
              {outdatedPeers > 0 && (
                <div style={{ marginTop: 8, color: "var(--warning)" }}>
                  {outdatedPeers} teammate{outdatedPeers === 1 ? "" : "s"}{" "}
                  {outdatedPeers === 1 ? "is" : "are"} on an older Chat and will keep seeing this channel until they
                  update.
                </div>
              )}
            </>
          }
          confirmLabel="Delete"
          tone="danger"
          busy={busy}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  );
}

export function UnreadBadge({
  count,
  tone = "accent",
}: {
  count: number;
  tone?: "accent" | "danger";
}) {
  return (
    <span
      style={{
        minWidth: 18,
        height: 16,
        padding: "0 5px",
        borderRadius: "var(--r-full)",
        background: tone === "danger" ? "var(--danger)" : "var(--accent)",
        color: "var(--on-accent)",
        fontSize: 11,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      {count > 99 ? "99+" : count}
    </span>
  );
}

/**
 * A fixed "team" conversation row (calendar, pull requests) — same metrics as
 * ChannelRow, but with a glyph instead of the `#` and an optional trailing
 * badge/chip supplied by the caller.
 */
function SpecialRow({
  name,
  icon,
  active,
  ariaLabel,
  title,
  trailing,
  onClick,
  action,
}: {
  name: string;
  icon: ReactNode;
  active: boolean;
  ariaLabel: string;
  title: string;
  trailing?: ReactNode;
  onClick: () => void;
  /** Optional secondary affordance: a small button revealed on hover, also reachable by right-click. */
  action?: { label: string; icon: ReactNode; onClick: () => void };
}) {
  const [hover, setHover] = useState(false);
  const showAction = action !== undefined && hover;
  return (
    <div
      style={{ position: "relative" }}
      onMouseEnter={action ? () => setHover(true) : undefined}
      onMouseLeave={action ? () => setHover(false) : undefined}
    >
      <button
        className="sem-row"
        onClick={onClick}
        onContextMenu={
          action
            ? (e) => {
                e.preventDefault();
                action.onClick();
              }
            : undefined
        }
        title={title}
        aria-label={ariaLabel}
        style={{
          position: "relative",
          width: "100%",
          height: 30,
          gap: 8,
          padding: "0 8px 0 10px",
          borderRadius: "var(--r-sm)",
          background: active ? "var(--accent-soft)" : undefined,
        }}
      >
        {active && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 0,
              top: 7,
              bottom: 7,
              width: 2,
              borderRadius: 2,
              background: "var(--accent)",
            }}
          />
        )}
        <span
          aria-hidden="true"
          style={{
            width: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: active ? "var(--text-1)" : "var(--text-3)",
            flexShrink: 0,
          }}
        >
          {icon}
        </span>
        <span
          style={{
            ...truncate,
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            color: active ? "var(--text-1)" : "var(--text-2)",
            transition: "color var(--t-fast) var(--ease-standard)",
          }}
        >
          {name}
        </span>
        {!showAction && trailing}
      </button>
      {showAction && (
        <button
          className="sem-row sem-focus"
          onClick={(e) => {
            e.stopPropagation();
            action.onClick();
          }}
          title={action.label}
          aria-label={action.label}
          style={{
            position: "absolute",
            right: 8,
            top: 6,
            width: 18,
            height: 18,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "var(--r-xs)",
            color: "var(--text-3)",
          }}
        >
          {action.icon}
        </button>
      )}
    </div>
  );
}

/** The "Set up" affordance shown on the PR row before anyone has connected. */
function SetupChip({ label = "Set up" }: { label?: string }) {
  return (
    <span
      style={{
        height: 16,
        padding: "0 6px",
        borderRadius: "var(--r-full)",
        background: "var(--bg-raised)",
        border: "1px solid var(--border-subtle)",
        color: "var(--text-3)",
        fontSize: 10,
        fontWeight: 600,
        display: "inline-flex",
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

/** Team section: the calendar and the pull-request group (spec §3). */
function TeamSection({
  activeConv,
  onOpen,
}: {
  activeConv: ConvId | null;
  onOpen: (conv: ConvId) => void;
}) {
  const calEvents = useStore((s) => s.events[TEAM_CONV.calendar]);
  const prsStatus = useStore((s) => s.prsStatus);
  const setPrsPrefsOpen = useStore((s) => s.setPrsPrefsOpen);

  // A hue dot on the calendar row when anything (including an annual entry)
  // falls on today — the calendar has no unread notion. Recomputed per render
  // (a string, so the memo below still only re-runs on an actual day change).
  const today = ymd(new Date());
  const somethingToday = useMemo(() => {
    if (!calEvents || calEvents.length === 0) return false;
    return (
      occurrencesInRange(materializeCalendar(calEvents), today, today).length >
      0
    );
  }, [calEvents, today]);

  const unseen = prsStatus?.unseen ?? 0;
  // 1.4: PRs waiting on reviewers past the team's SLA — surfaced here too so
  // the row hints at it without opening the pane (the badge itself still
  // counts only unseen-needing-review, unchanged).
  const overdue = prsStatus?.overdue ?? 0;

  // Someone set the group up without sharing their token: this machine polls
  // nothing, so `unseen` stays 0 forever and the row would otherwise be
  // indistinguishable from a quiet, working group. The chip is the only cue
  // that the pane is waiting for a personal token.
  const needsToken =
    prsStatus?.configured === true && prsStatus.tokenSource === "none";

  return (
    <>
      <div style={{ padding: "10px 8px 4px" }}>
        <SectionLabel>Team</SectionLabel>
      </div>
      <SpecialRow
        name="Calendar"
        icon={<IconCalendar size={13} />}
        active={activeConv === TEAM_CONV.calendar}
        title={
          somethingToday
            ? "Team calendar — something is on today"
            : "Team calendar"
        }
        ariaLabel={`Team calendar${somethingToday ? ", something is on today" : ""}`}
        onClick={() => onOpen(TEAM_CONV.calendar)}
        trailing={
          somethingToday ? (
            <span
              aria-hidden="true"
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                background: "var(--accent)",
                flexShrink: 0,
              }}
            />
          ) : undefined
        }
      />
      <SpecialRow
        name="Pull requests"
        icon={<IconGitPull size={13} />}
        active={activeConv === TEAM_CONV.prs}
        title={
          (prsStatus && !prsStatus.configured
            ? "Pull requests — not connected to Azure DevOps yet"
            : needsToken
              ? "Pull requests — enter your Azure DevOps token to start watching"
              : unseen > 0
                ? `Pull requests — ${unseen} waiting`
                : "Pull requests") + (overdue > 0 ? ` · ${overdue} overdue` : "")
        }
        ariaLabel={
          (prsStatus && !prsStatus.configured
            ? "Pull requests, set up needed"
            : needsToken
              ? "Pull requests, your Azure DevOps token is needed"
              : `Pull requests${unseen > 0 ? `, ${unseen} unseen` : ""}`) +
          (overdue > 0 ? `, ${overdue} overdue` : "")
        }
        onClick={() => onOpen(TEAM_CONV.prs)}
        action={{
          label: "Pull request settings",
          icon: <IconGear size={12} />,
          onClick: () => setPrsPrefsOpen(true),
        }}
        trailing={
          prsStatus && !prsStatus.configured ? (
            <SetupChip />
          ) : needsToken ? (
            <SetupChip label="Add token" />
          ) : unseen > 0 ? (
            <UnreadBadge count={unseen} tone="danger" />
          ) : undefined
        }
      />
    </>
  );
}

function DmRow({
  p,
  label,
  active,
  unread,
}: {
  p: PresenceView;
  /** The row's name — `p.name` plus "(previous device)" after a re-join. */
  label: string;
  active: boolean;
  unread: number;
}) {
  // A superseded device is listed for its history alone (1.4) — there is
  // nobody behind it to accept a beam, so the row takes the drag and says so
  // rather than offering a file to a machine that can never answer.
  const beam = useBeamTarget(p.deviceId, p.name, !p.supersededBy);
  const offline = p.state === "offline";
  const hasUnread = unread > 0;
  return (
    <button
      className="sem-row"
      onClick={() => void openDm(p.deviceId)}
      title={`Message ${label} (${p.hostname}·${p.fingerprint})${p.status ? ` — ${p.status}` : ""}`}
      aria-label={`Direct message ${label}, ${p.state}${p.status ? `, status ${p.status}` : ""}${hasUnread ? `, ${unread} unread` : ""}`}
      {...beam.props}
      style={{
        position: "relative",
        width: "100%",
        height: beam.over ? 52 : 44,
        gap: 8,
        padding: "0 8px",
        borderRadius: "var(--r-sm)",
        background: beam.over
          ? "var(--flare-soft)"
          : active
            ? "var(--accent-soft)"
            : undefined,
        boxShadow: beam.over ? "inset 0 0 0 1px var(--flare)" : undefined,
        transition:
          "height var(--t-fast) var(--ease-standard), background var(--t-fast) var(--ease-standard), box-shadow var(--t-fast) var(--ease-standard)",
      }}
    >
      {beam.over ? (
        <BeamLabel name={p.name} blocked={beam.blocked} />
      ) : (
        <>
          {active && (
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 0,
                top: 12,
                bottom: 12,
                width: 2,
                borderRadius: 2,
                background: "var(--accent)",
              }}
            />
          )}
          <Avatar
            name={p.name}
            size={24}
            presence={p.state}
            desaturate={p.state === "away"}
          />
          {/* Two lines now (1.4): the name, then whatever they said they're
              doing. The device chip rides the second line and only shows
              itself on hover/focus — it was the loudest thing in the row and
              the one people needed least often. */}
          <PersonLines
            name={label}
            status={p.status}
            state={p.state}
            departed={p.departed}
            hostname={p.hostname}
            fingerprint={p.fingerprint}
            warn={p.trust === "flagged"}
            nameWeight={hasUnread ? 600 : 400}
            nameColor={
              offline && !hasUnread ? "var(--text-3)" : "var(--text-1)"
            }
          />
          {hasUnread && <UnreadBadge count={unread} />}
        </>
      )}
    </button>
  );
}

/** Private-group sidebar row (1.2): lock glyph, DM-style unread badge, role-based menu. */
function GroupRow({
  group,
  active,
  unread,
  onClick,
}: {
  group: GroupView;
  active: boolean;
  unread: number;
  onClick: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState(group.name);
  const [addOpen, setAddOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const renameRef = useRef<HTMLInputElement>(null);
  const isOwner = group.role === "owner";

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  const hasUnread = unread > 0;
  const showTrigger = hover || menuOpen;

  async function submitRename() {
    // Same shared decision as the channel row above (renamePlan.ts) — the
    // group cap lives there now, not as a `60` typed in three places.
    const plan = planRename({ kind: "group", current: group.name, input: renameValue });
    setRenaming(false);
    if (plan.action !== "rename") return;
    try {
      await window.bridge.groups.rename(group.conv, plan.name);
    } catch (err) {
      toast(
        `Could not rename the group — ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
    }
  }

  async function doLeave() {
    setBusy(true);
    try {
      await window.bridge.groups.leave(group.conv);
      setLeaveOpen(false);
    } catch (err) {
      toast(`Could not leave — ${err instanceof Error ? err.message : String(err)}`, "danger");
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    setBusy(true);
    try {
      await window.bridge.groups.remove(group.conv);
      setDeleteOpen(false);
    } catch (err) {
      toast(
        `Could not delete the group — ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
    } finally {
      setBusy(false);
    }
  }

  if (renaming) {
    return (
      <div style={{ padding: "2px 8px 2px 10px" }}>
        <input
          ref={renameRef}
          className="sem-input"
          style={{ height: 28, fontSize: 12 }}
          value={renameValue}
          maxLength={convNameMax("group")}
          aria-label={`Rename ${group.name}`}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          onBlur={() => void submitRename()}
          spellCheck={false}
        />
      </div>
    );
  }

  return (
    <div
      className="sem-row-hoverable"
      style={{ position: "relative" }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        className="sem-row"
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenuOpen(true);
        }}
        title={group.name}
        aria-label={`Group ${group.name}${hasUnread ? `, ${unread} unread` : ""}`}
        style={{
          position: "relative",
          width: "100%",
          height: 30,
          gap: 8,
          padding: "0 8px 0 10px",
          borderRadius: "var(--r-sm)",
          background: active ? "var(--accent-soft)" : undefined,
        }}
      >
        {active && (
          <span
            aria-hidden="true"
            style={{
              position: "absolute",
              left: 0,
              top: 7,
              bottom: 7,
              width: 2,
              borderRadius: 2,
              background: "var(--accent)",
            }}
          />
        )}
        <span
          aria-hidden="true"
          style={{
            width: 14,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: identityHue(group.name),
            filter: "saturate(0.6)",
            flexShrink: 0,
          }}
        >
          <IconLock size={12} />
        </span>
        <span
          style={{
            ...truncate,
            flex: 1,
            minWidth: 0,
            fontSize: 13,
            fontWeight: hasUnread ? 600 : 400,
            color: active || hasUnread ? "var(--text-1)" : "var(--text-2)",
            transition: "color var(--t-fast) var(--ease-standard)",
          }}
        >
          {group.name}
        </span>
        {!showTrigger && hasUnread && (
          <span className="sem-row-badge">
            <UnreadBadge count={unread} />
          </span>
        )}
      </button>

      <button
        className="sem-row sem-focus sem-row-trigger"
        data-open={menuOpen ? "1" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setMenuOpen((v) => !v);
        }}
        title="Group options"
        aria-label={`Options for ${group.name}`}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={{
          position: "absolute",
          right: 6,
          top: 6,
          width: 18,
          height: 18,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          borderRadius: "var(--r-xs)",
          color: "var(--text-3)",
        }}
      >
        <IconMore size={13} />
      </button>
      <Dropdown open={menuOpen} onClose={() => setMenuOpen(false)}>
        <MenuItem
          onClick={() => {
            setMenuOpen(false);
            setRenameValue(group.name);
            setRenaming(true);
          }}
        >
          Rename…
        </MenuItem>
        {isOwner ? (
          <>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                setAddOpen(true);
              }}
            >
              Add people…
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuOpen(false);
                setManageOpen(true);
              }}
            >
              Manage members…
            </MenuItem>
            <MenuItem
              danger
              onClick={() => {
                setMenuOpen(false);
                setDeleteOpen(true);
              }}
            >
              Delete group…
            </MenuItem>
          </>
        ) : (
          <MenuItem
            danger
            onClick={() => {
              setMenuOpen(false);
              setLeaveOpen(true);
            }}
          >
            Leave…
          </MenuItem>
        )}
      </Dropdown>

      {addOpen && <GroupDialog mode="edit" group={group} canRemove={false} onClose={() => setAddOpen(false)} />}
      {manageOpen && <GroupDialog mode="edit" group={group} canRemove={true} onClose={() => setManageOpen(false)} />}
      {leaveOpen && (
        <ConfirmDialog
          title={`Leave 🔒 ${group.name}?`}
          message="You'll stop seeing new messages here. Someone still in the group can add you back later."
          confirmLabel="Leave"
          tone="danger"
          busy={busy}
          onConfirm={() => void doLeave()}
          onClose={() => setLeaveOpen(false)}
        />
      )}
      {deleteOpen && (
        <ConfirmDialog
          title={`Delete 🔒 ${group.name}?`}
          message={`Delete this group for everyone? Messages stay on the share until the next cleanup (about ${RETENTION.deletedConvGraceDays} days), then they're gone.`}
          confirmLabel="Delete"
          tone="danger"
          busy={busy}
          onConfirm={() => void doDelete()}
          onClose={() => setDeleteOpen(false)}
        />
      )}
    </div>
  );
}

function StatusPopover({
  currentStatus,
  appearOffline,
  hostname,
  fingerprint,
  onClose,
}: {
  currentStatus: string;
  appearOffline: boolean;
  hostname: string;
  fingerprint: string;
  onClose: () => void;
}) {
  const [text, setText] = useState(currentStatus);
  const [offline, setOffline] = useState(appearOffline);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function save() {
    try {
      await window.bridge.presence.setStatus(text.trim());
      toast(text.trim() ? "Status set" : "Status cleared", "success");
      onClose();
    } catch {
      toast("Could not set status", "danger");
    }
  }

  async function setAppear(v: boolean) {
    setOffline(v);
    try {
      await window.bridge.presence.setAppearState(v ? "offline" : "online");
    } catch {
      toast("Could not change presence", "danger");
    }
  }

  return (
    <>
      <div
        style={{ position: "fixed", inset: 0, zIndex: 70 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="Status"
        className="sem-frost"
        style={{
          position: "absolute",
          left: 8,
          right: 8,
          bottom: 58,
          zIndex: 71,
          borderRadius: "var(--r-lg)",
          border: "1px solid var(--border-subtle)",
          boxShadow: "var(--elev-2)",
          padding: 12,
          animation: "sem-rise var(--t-base) var(--ease-pop)",
        }}
      >
        {/* The identity chip used to live in the footer row; it moved here
            (and into the footer button's title/aria-label) so a long status
            never has to fight it for width. */}
        <div style={{ display: "flex", marginBottom: 10 }}>
          <DeviceChip hostname={hostname} fingerprint={fingerprint} />
        </div>
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.06em",
            color: "var(--text-3)",
            marginBottom: 6,
          }}
        >
          STATUS
        </div>
        <input
          ref={inputRef}
          className="sem-input"
          placeholder="What's happening?"
          value={text}
          maxLength={STATUS_MAX}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") onClose();
          }}
          aria-label="Status text"
        />
        <div
          style={{ display: "flex", justifyContent: "flex-end", marginTop: 8 }}
        >
          <button
            className="sem-chip-btn"
            onClick={() => void save()}
            title="Save status"
            style={{ height: 24, fontSize: 11 }}
          >
            Save
          </button>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 10,
            paddingTop: 10,
            borderTop: "1px solid var(--border-subtle)",
          }}
        >
          <span style={{ fontSize: 13, color: "var(--text-2)" }}>
            Appear offline
          </span>
          <Toggle
            on={offline}
            onChange={(v) => void setAppear(v)}
            label="Appear offline"
          />
        </div>
      </div>
    </>
  );
}

/**
 * Team name + share health. Lives inside the sidebar (spec §2.2) rather than
 * in the titlebar strip, so it can never collide with the macOS traffic
 * lights regardless of how the OS insets them.
 */
function TeamBlock() {
  const boot = useStore((s) => s.boot);
  const health = useStore((s) => s.health);
  const self = selfOf(boot);
  const slow =
    health.reachable && health.latencyMs !== null && health.latencyMs >= 500;
  const color = !health.reachable
    ? "var(--danger)"
    : slow
      ? "var(--warning)"
      : "var(--success)";
  const label = !health.reachable
    ? "Share unreachable"
    : slow
      ? `Share slow · ${health.latencyMs}ms`
      : `Share connected${health.latencyMs !== null ? ` · ${health.latencyMs}ms` : ""}`;

  return (
    <div
      style={{
        height: 52,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        gap: 2,
        padding: "0 12px 0 16px",
        minWidth: 0,
        userSelect: "none",
      }}
    >
      <span
        // The name can be renamed by any member now (1.5) and this row
        // truncates, so it carries its own tooltip — and gives the E2E script
        // something exact to look for.
        title={self?.teamName ?? "Chat"}
        style={{
          ...truncate,
          fontSize: 15,
          fontWeight: 600,
          color: "var(--text-1)",
        }}
      >
        {self?.teamName ?? "Chat"}
      </span>
      <span
        title={
          !health.reachable
            ? "The team folder cannot be reached right now. Messages queue on this machine."
            : slow
              ? "The share is responding slowly — messages may take a few seconds to appear."
              : "Connected to the team folder."
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 11,
          color: "var(--text-3)",
          minWidth: 0,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
          }}
        />
        <span style={truncate}>{label}</span>
      </span>
    </div>
  );
}

export default function Sidebar({
  onOpenSettings,
}: {
  onOpenSettings: () => void;
}) {
  const channels = useStore((s) => s.channels);
  const groups = useStore((s) => s.groups);
  const presence = useStore((s) => s.presence);
  const boot = useStore((s) => s.boot);
  const activeConv = useStore((s) => s.activeConv);
  const setActiveConv = useStore((s) => s.setActiveConv);
  // Subscribed so unread counts refresh as events/read-cursors change.
  const events = useStore((s) => s.events);
  const myReads = useStore((s) => s.myReads);
  const unreadCount = useStore((s) => s.unreadCount);
  const dmPeers = useDmMap((s) => s.peers);
  const self = selfOf(boot);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [statusOpen, setStatusOpen] = useState(false);
  const [notifyOpen, setNotifyOpen] = useState(false);
  const [groupDialogOpen, setGroupDialogOpen] = useState(false);
  const addRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (adding) addRef.current?.focus();
  }, [adding]);

  // Departed devices drop off the list — unless they left us something
  // unread, in which case the row stays until it has been opened. A device
  // superseded by a re-join from the same machine (1.4) is stricter still: it
  // is only ever listed when that DM holds history, and then under
  // "(previous device)" — see peopleRows.
  const others = useMemo(
    () =>
      peopleRows(presence, self?.deviceId ?? "", {
        hasHistory: (conv) =>
          (events[conv] ?? []).some((e) => e.type === "msg"),
        unread: (conv) => unreadCount(conv),
      }),
    // events/myReads are what unreadCount reads; listing them keeps the memo honest.
    [presence, self?.deviceId, unreadCount, events, myReads],
  );

  // Our own row comes from main's 'self-presence' push (1.4), not from
  // `presence` — that list is everyone *else* by construction, so looking for
  // ourselves in it always came back undefined and the footer could never show
  // the status we had just set.
  const selfPresence = useStore((s) => s.selfPresence);

  async function createChannel() {
    const name = normalizeChannelName(newName);
    if (!name) {
      setAdding(false);
      return;
    }
    try {
      const ch = await window.bridge.chat.createChannel(name);
      setActiveConv(ch.conv);
      setAdding(false);
      setNewName("");
    } catch (err) {
      toast(
        `Could not create #${name} — ${err instanceof Error ? err.message : String(err)}`,
        "danger",
      );
    }
  }

  return (
    <div
      style={{
        width: 260,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-sidebar)",
        borderRight: "1px solid var(--border-subtle)",
        position: "relative",
        minHeight: 0,
      }}
    >
      <TeamBlock />
      <QuickSwitcher />

      <div
        className="sem-scroll"
        style={{ flex: 1, minHeight: 0, padding: "4px 8px 8px" }}
      >
        <TeamSection activeConv={activeConv} onOpen={setActiveConv} />

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 8px 4px",
          }}
        >
          <SectionLabel>Channels</SectionLabel>
          <button
            className="sem-row sem-focus"
            onClick={() => setAdding(true)}
            title="Create a channel"
            aria-label="Create a channel"
            style={{
              width: 18,
              height: 18,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--r-xs)",
              color: "var(--text-3)",
            }}
          >
            <IconPlus size={12} />
          </button>
        </div>

        {adding && (
          <div style={{ padding: "2px 0 4px" }}>
            <input
              ref={addRef}
              className="sem-input"
              style={{ height: 28, fontSize: 12 }}
              placeholder="channel-name"
              aria-label="New channel name"
              maxLength={CHANNEL_NAME_MAX}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createChannel();
                if (e.key === "Escape") {
                  setAdding(false);
                  setNewName("");
                }
              }}
              onBlur={() => {
                setAdding(false);
                setNewName("");
              }}
              spellCheck={false}
            />
          </div>
        )}

        {channels.map((ch) => (
          <ChannelRow
            key={ch.conv}
            conv={ch.conv}
            name={ch.name}
            active={activeConv === ch.conv}
            unread={activeConv === ch.conv ? 0 : unreadCount(ch.conv)}
            fixed={ch.fixed}
            onClick={() => setActiveConv(ch.conv)}
          />
        ))}
        {!channels.length && (
          <div
            style={{ padding: "4px 8px", fontSize: 12, color: "var(--text-3)" }}
          >
            No channels yet — create one.
          </div>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 8px 4px",
          }}
        >
          <SectionLabel>Groups</SectionLabel>
          <button
            className="sem-row sem-focus"
            onClick={() => setGroupDialogOpen(true)}
            title="Create a private group"
            aria-label="Create a private group"
            style={{
              width: 18,
              height: 18,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--r-xs)",
              color: "var(--text-3)",
            }}
          >
            <IconPlus size={12} />
          </button>
        </div>
        {groups.map((g) => (
          <GroupRow
            key={g.conv}
            group={g}
            active={activeConv === g.conv}
            unread={activeConv === g.conv ? 0 : unreadCount(g.conv)}
            onClick={() => setActiveConv(g.conv)}
          />
        ))}
        {!groups.length && (
          <div
            style={{ padding: "4px 8px", fontSize: 12, color: "var(--text-3)" }}
          >
            No private groups yet.
          </div>
        )}

        <div style={{ padding: "16px 8px 4px" }}>
          <SectionLabel>Direct messages</SectionLabel>
        </div>
        {others.map(({ person: p, label }) => (
          <DmRow
            key={p.deviceId}
            p={p}
            label={label}
            active={activeConv !== null && dmPeers[activeConv] === p.deviceId}
            unread={activeConv === p.dmConv ? 0 : unreadCount(p.dmConv)}
          />
        ))}
        {!others.length && (
          <div
            style={{ padding: "4px 8px", fontSize: 12, color: "var(--text-3)" }}
          >
            Nobody else yet. Teammates appear here when they join the folder.
          </div>
        )}
      </div>

      {self && (
        <div
          style={{
            height: 56,
            flexShrink: 0,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "0 8px",
            borderTop: "1px solid var(--border-subtle)",
            position: "relative",
          }}
        >
          <button
            className="sem-row"
            onClick={() => {
              setNotifyOpen(false);
              setStatusOpen((v) => !v);
            }}
            title={`${selfPresence?.status ? `Status: ${selfPresence.status}` : "Set your status"} — device ${self.hostname} · key fingerprint ${self.fingerprint}`}
            aria-label={`${selfPresence?.status ? `Your status: ${selfPresence.status}. Change it.` : "Set your status."} Device ${self.hostname}, key fingerprint ${self.fingerprint}.`}
            aria-expanded={statusOpen}
            style={{
              flex: 1,
              minWidth: 0,
              height: 44,
              gap: 8,
              padding: "0 6px",
              borderRadius: "var(--r-sm)",
            }}
          >
            <Avatar
              name={self.displayName}
              size={28}
              presence={selfPresence?.state ?? "online"}
            />
            {/* Name, then the status underneath — the same two lines every
                person row shows. The device chip stays out of the footer (it
                is in this button's title/aria-label and in the popover), so
                nothing here competes with a long status. */}
            <PersonLines
              name={self.displayName}
              status={selfPresence?.status}
              state={selfPresence?.state ?? "online"}
              self
              nameWeight={600}
            />
          </button>
          {/* 1.4 — the quick notification controls, next to the gear: the
              settings people change mid-conversation, without the modal. */}
          <NotificationsBell
            open={notifyOpen}
            onToggle={() => {
              setStatusOpen(false);
              setNotifyOpen((v) => !v);
            }}
          />
          <button
            className="sem-row sem-focus"
            onClick={onOpenSettings}
            title="Settings"
            aria-label="Open settings"
            style={{
              width: 28,
              height: 28,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: "var(--r-sm)",
              color: "var(--text-2)",
            }}
          >
            <IconGear size={16} />
          </button>

          {notifyOpen && (
            <NotificationsPopover
              placement="sidebar"
              onClose={() => setNotifyOpen(false)}
            />
          )}

          {statusOpen && (
            <StatusPopover
              currentStatus={selfPresence?.status ?? ""}
              appearOffline={selfPresence?.state === "offline"}
              hostname={self.hostname}
              fingerprint={self.fingerprint}
              onClose={() => setStatusOpen(false)}
            />
          )}
        </div>
      )}

      {groupDialogOpen && (
        <GroupDialog mode="create" onClose={() => setGroupDialogOpen(false)} />
      )}
    </div>
  );
}
