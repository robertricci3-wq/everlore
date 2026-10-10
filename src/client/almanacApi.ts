import type { MemoryInvitationRecord } from "../shared/invitations.js";
export interface AlmanacPageView {
  id: string;
  title: string;
  description: string;
  chapterId: string | null;
  position: number;
  hidden: boolean;
  custom: boolean;
  invitationIds: string[];
  memoryCount: number;
  bookCount: number;
  coverProjectId: string | null;
  coverUrl: string | null;
}
export interface AlmanacBookView {
  projectId: string;
  title: string;
  status: string;
  revision: number;
  coverUrl: string | null;
  pageIds: string[];
  sourceSessionId: string | null;
}
export interface AlmanacDraftView {
  id: string;
  projectId: string;
  pageId: string;
  invitationId: string;
  status: string;
  turnCount: number;
  updatedAt: string;
}
export interface AlmanacView {
  version: 1;
  pages: AlmanacPageView[];
  books: AlmanacBookView[];
  drafts: AlmanacDraftView[];
  titleDrafts: AlmanacDraftView[];
}
export interface AlmanacPageDetail {
  page: AlmanacPageView;
  sessions: AlmanacDraftView[];
  titleSessions: AlmanacDraftView[];
  books: AlmanacBookView[];
  invitations: MemoryInvitationRecord[];
}
