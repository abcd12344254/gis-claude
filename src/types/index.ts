import type { Feature, FeatureCollection, Geometry, GeoJsonProperties } from 'geojson';

export interface GISLayer {
  id: string;
  name: string;
  type: 'point' | 'line' | 'polygon' | 'raster' | 'geojson';
  visible: boolean;
  color: string;
  opacity: number;
  data?: FeatureCollection;
  sourceId: string;
  layerId: string;
  createdAt: number;
}

export interface DrawingState {
  active: boolean;
  type: 'Point' | 'LineString' | 'Polygon' | null;
}

export interface SpatialAnalysisResult {
  type: string;
  result: FeatureCollection | number | null;
  description: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  spatialContext?: {
    center: [number, number];
    zoom: number;
    layers: string[];
  };
  routeData?: {
    distance: number;
    duration: number;
    steps: Array<{
      distance: number;
      duration: number;
      instruction: string;
      name: string;
    }>;
    startName: string;
    endName: string;
  };
}

export interface MapState {
  center: [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  bounds: [number, number, number, number] | null; // [west, south, east, north]
}

export interface MeasurementResult {
  type: 'distance' | 'area';
  value: number;
  unit: string;
  points: [number, number][];
}

export type SpatialToolType =
  | 'buffer'
  | 'intersect'
  | 'union'
  | 'difference'
  | 'centroid'
  | 'area'
  | 'distance'
  | 'bbox'
  | 'simplify'
  | 'convex';

export interface AnalysisTask {
  id: string;
  tool: SpatialToolType;
  params: Record<string, unknown>;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: SpatialAnalysisResult;
  error?: string;
}
