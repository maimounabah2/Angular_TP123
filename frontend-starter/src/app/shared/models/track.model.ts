/** Audio track metadata returned by the API. */
export interface Track {
  id: string;
  title: string;
  artist?: string;
  originalName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  coverUrl?: string | null;
  coverSourceUrl?: string | null;
}

export interface CoverSearchResult {
  releaseId: string;
  title: string;
  artist: string;
  date: string;
  sourceUrl: string;
  coverUrl: string;
}
