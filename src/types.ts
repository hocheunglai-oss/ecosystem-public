import type { Contribution } from "./lib/model";
export type Page =
  | "home"
  | "enquiry"
  | "companies"
  | "ports"
  | "credit"
  | "records"
  | "audit"
  | "management";
export type ModalSpec =
  | { type: "credit"; companyId: string; enquiryId?: string }
  | { type: "decision"; id: string }
  | { type: "outcome"; id: string; kind: "fixture" | "lost" }
  | { type: "company"; name?: string }
  | {
      type: "contribute";
      targetType: Contribution["targetType"];
      targetId: string;
    }
  | { type: "actual-volume"; id: string }
  | { type: "enquiry-detail"; id: string }
  | { type: "review-contribution"; id: string };
export type OpenModal = (modal: ModalSpec) => void;
