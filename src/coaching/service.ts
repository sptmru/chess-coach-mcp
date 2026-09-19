import { and, desc, eq, isNull } from 'drizzle-orm';
import type { DB } from '../database/client.js';
import { notes, focuses, goals, profiles } from '../database/schema.js';
import type { IdentityService } from '../services/identity.js';
import type { ReportService } from '../services/reports.js';
import { missing } from '../utils/core.js';
export class CoachingService {
  constructor(
    readonly db: DB,
    readonly identity: IdentityService,
    readonly reports: ReportService,
  ) {}
  async addNote(
    userId: string,
    identityId: string | undefined,
    input: {
      note: string;
      category?: string;
      relatedPattern?: string;
      reviewAfterGames?: number;
      reviewAfterDate?: string;
    },
  ) {
    const i = await this.identity.require(userId, identityId);
    const baseline = await this.reports.report(userId, i.id);
    const [note] = await this.db
      .insert(notes)
      .values({
        ...input,
        reviewAfterDate: input.reviewAfterDate ? new Date(input.reviewAfterDate) : null,
        userId,
        identityId: i.id,
        baselineGames: baseline.availableGames,
      })
      .returning();
    return note;
  }
  async notes(
    userId: string,
    identityId: string | undefined,
    limit = 20,
    offset = 0,
    includeArchived = false,
  ) {
    const i = await this.identity.require(userId, identityId);
    const items = await this.db
      .select()
      .from(notes)
      .where(
        and(
          eq(notes.userId, userId),
          eq(notes.identityId, i.id),
          includeArchived ? undefined : isNull(notes.archivedAt),
        ),
      )
      .orderBy(desc(notes.createdAt), desc(notes.id))
      .limit(limit + 1)
      .offset(offset);
    return {
      items: items.slice(0, limit),
      nextOffset: items.length > limit ? offset + limit : null,
    };
  }
  async archiveNote(userId: string, id: string) {
    const [note] = await this.db
      .update(notes)
      .set({ archivedAt: new Date() })
      .where(and(eq(notes.userId, userId), eq(notes.id, id)))
      .returning({ id: notes.id });
    if (!note) throw missing();
    return { id: note.id, archived: true };
  }
  async setFocus(
    userId: string,
    identityId: string | undefined,
    input: {
      focus: string;
      reason: string;
      targetPattern?: string;
      durationGames?: number;
      reviewDate?: string;
    },
  ) {
    const i = await this.identity.require(userId, identityId);
    const baseline = await this.reports.report(userId, i.id);
    const [focus] = await this.db
      .insert(focuses)
      .values({
        ...input,
        reviewDate: input.reviewDate ? new Date(input.reviewDate) : null,
        userId,
        identityId: i.id,
        baseline,
      })
      .returning();
    return focus;
  }
  async focuses(userId: string, identityId: string | undefined, limit = 20, offset = 0) {
    const i = await this.identity.require(userId, identityId);
    const items = await this.db
      .select()
      .from(focuses)
      .where(and(eq(focuses.userId, userId), eq(focuses.identityId, i.id)))
      .orderBy(desc(focuses.createdAt), desc(focuses.id))
      .limit(limit + 1)
      .offset(offset);
    return {
      items: items.slice(0, limit),
      nextOffset: items.length > limit ? offset + limit : null,
    };
  }
  async completeFocus(userId: string, id: string, state: 'completed' | 'abandoned') {
    const [focus] = await this.db
      .select()
      .from(focuses)
      .where(and(eq(focuses.userId, userId), eq(focuses.id, id)));
    if (!focus) throw missing();
    if (focus.state !== 'started') return focus;
    const baseline = focus.baseline as { analysisKey: string | null; meanCpl: number | null };
    const end = await this.reports.report(userId, focus.identityId, {
      since: focus.createdAt.toISOString(),
      ...(baseline.analysisKey ? { analysisKey: baseline.analysisKey } : {}),
    });
    const changes = {
      meanCpl:
        baseline.meanCpl !== null && end.meanCpl !== null ? end.meanCpl - baseline.meanCpl : null,
      comparable: baseline.analysisKey === end.analysisKey && end.gamesAnalyzed > 0,
      warning: 'Observed change is not evidence that this focus caused it',
    };
    const [saved] = await this.db
      .update(focuses)
      .set({ state, endMetrics: end, changes, completedAt: new Date() })
      .where(and(eq(focuses.userId, userId), eq(focuses.id, id), eq(focuses.state, 'started')))
      .returning();
    return saved ?? focus;
  }
  async goal(
    userId: string,
    identityId: string | undefined,
    input: { goal: string; targetRating?: number; targetDate?: string },
  ) {
    const i = await this.identity.require(userId, identityId);
    const [goal] = await this.db
      .insert(goals)
      .values({
        ...input,
        targetDate: input.targetDate ? new Date(input.targetDate) : null,
        userId,
        identityId: i.id,
      })
      .returning();
    return goal;
  }
  async goals(userId: string, identityId: string | undefined, limit = 20, offset = 0) {
    const i = await this.identity.require(userId, identityId);
    const items = await this.db
      .select()
      .from(goals)
      .where(and(eq(goals.userId, userId), eq(goals.identityId, i.id)))
      .orderBy(desc(goals.createdAt), desc(goals.id))
      .limit(limit + 1)
      .offset(offset);
    return {
      items: items.slice(0, limit),
      nextOffset: items.length > limit ? offset + limit : null,
    };
  }
  async context(userId: string, identityId: string | undefined) {
    const i = await this.identity.require(userId, identityId);
    const report = await this.reports.report(userId, i.id);
    const [profile] = await this.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.userId, userId), eq(profiles.identityId, i.id)));
    const pattern = await this.reports.mistakePatterns(userId, i.id);
    return {
      identity: i,
      computed: {
        rating: report.ratingSnapshot,
        recent: {
          games: report.gamesAnalyzed,
          acpl: report.meanCpl,
          majorMistakesPerGame: report.majorMistakesPerGame,
        },
        weaknesses: pattern.items
          .filter((p) => p.detected)
          .slice(0, 8)
          .map((p) => ({
            type: p.type,
            trend: p.trend,
            frequency: p.frequency,
            sampleGames: p.sampleGames,
          })),
        warnings: report.warnings,
        analysisKey: report.analysisKey,
      },
      coachAuthored: {
        repertoire: profile?.repertoire ?? {},
        notes: (await this.notes(userId, i.id, 5)).items.map((n) => ({
          id: n.id,
          note: n.note,
          reviewAfterGames: n.reviewAfterGames,
          reviewAfterDate: n.reviewAfterDate,
        })),
        trainingFocus: (await this.focuses(userId, i.id, 10)).items
          .filter((f) => f.state === 'started')
          .map((f) => ({ id: f.id, focus: f.focus, reviewDate: f.reviewDate })),
        goals: (await this.goals(userId, i.id, 5)).items.map((g) => ({
          id: g.id,
          goal: g.goal,
          targetRating: g.targetRating,
        })),
      },
    };
  }
}
