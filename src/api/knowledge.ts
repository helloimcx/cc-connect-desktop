import {
  createKnowledgeBase,
  createKnowledgeFolder,
  deleteKnowledgeBase,
  deleteKnowledgeBaseFile,
  deleteKnowledgeFolder,
  getKnowledgeBase,
  getKnowledgeConfig,
  listKnowledgeBaseFiles,
  listKnowledgeBases,
  listKnowledgeFolders,
  listKnowledgeSources,
  saveKnowledgeConfig,
  searchKnowledgeBase,
  updateKnowledgeBase,
  updateKnowledgeFolder,
  uploadKnowledgeBaseFiles,
} from '../../packages/core-sdk/src';
import type {
  KnowledgeBaseCreateInput,
  KnowledgeBaseUpdateInput,
  KnowledgeConfig,
  KnowledgeFolderCreateInput,
  KnowledgeFolderUpdateInput,
  KnowledgeSearchInput,
} from '../../packages/contracts/src';

export {
  createKnowledgeBase,
  createKnowledgeFolder,
  deleteKnowledgeBase,
  deleteKnowledgeBaseFile,
  deleteKnowledgeFolder,
  getKnowledgeBase,
  getKnowledgeConfig,
  listKnowledgeBaseFiles,
  listKnowledgeBases,
  listKnowledgeFolders,
  listKnowledgeSources,
  saveKnowledgeConfig,
  searchKnowledgeBase,
  updateKnowledgeBase,
  updateKnowledgeFolder,
  uploadKnowledgeBaseFiles,
};

export type {
  KnowledgeBaseCreateInput,
  KnowledgeBaseUpdateInput,
  KnowledgeConfig,
  KnowledgeFolderCreateInput,
  KnowledgeFolderUpdateInput,
  KnowledgeSearchInput,
};
