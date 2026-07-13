export interface ClassHierarchyDisplayNode {
  id: string;
  name: string;
  kind?: string;
  external?: boolean;
  path?: string;
  line?: number;
  column?: number;
  children: string[];
}

export interface ClassHierarchyModel {
  roots: string[];
  nodes: ClassHierarchyDisplayNode[];
  classCount: number;
  externalBaseCount: number;
  parsedFileCount: number;
  partialIndex: boolean;
}
