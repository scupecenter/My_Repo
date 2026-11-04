import { Activity, BellRing, ClipboardList, GitCommitHorizontal, History, PackageCheck, BadgeCheck, BarChart3, Bell, Flag, Gauge, Cable, CalendarDays, CircleAlert, Eye, FileText, GitPullRequest, HardHat, Home, Inbox, KeyRound, Mail, ShieldAlert, Landmark, LayoutGrid, Megaphone, MessageSquare, Radio, Rocket, Ruler, ScrollText, Settings, ShieldCheck, ShoppingCart, Table2, TriangleAlert, Users, Users2, UsersRound, UserX, Warehouse, Wrench, Zap, type LucideIcon } from 'lucide-react';

/** One Lucide icon per concept (plan 2.12). Screens ask for a concept, never import an icon ad hoc. */
export const ICONS = {
  home: Home, site: LayoutGrid, register: FileText, warehouse: Warehouse, approval: Inbox, document: FileText, holder: Users, late: TriangleAlert,
  dashboard: BarChart3, message: MessageSquare, announcement: Megaphone, procurement: ShoppingCart, power: Zap, fiber: Cable, permit: HardHat, dismantle: Wrench,
  contractor: Users2, quality: BadgeCheck, issue: CircleAlert, change: GitPullRequest, handover: Rocket, asbuilt: Ruler, meeting: CalendarDays, rf: Radio, acquisition: Landmark,
  inbox: Bell, workload: Gauge, weekly: Flag, people: Users, role: KeyRound, group: UsersRound, delegation: ShieldCheck, absence: UserX, matrix: Table2, settings: Settings, securityLog: ScrollText, online: Activity, audit: Eye, fieldChanges: History, alerts: BellRing, jobRuns: GitCommitHorizontal, deployments: PackageCheck, report: ClipboardList, integrity: ShieldAlert, mail: Mail,
} satisfies Record<string, LucideIcon>;
export type Concept = keyof typeof ICONS;

/** Icon defaults from the plan: 16 px list/inline, 20 px headers, stroke 1.75. */
export const ICON_PROPS = { size: 16, strokeWidth: 1.75, 'aria-hidden': true } as const;
