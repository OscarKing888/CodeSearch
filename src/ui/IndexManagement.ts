import { IndexManagePanel } from './IndexManagePanel';

export function manageIndexes(): void {
  IndexManagePanel.show();
}

export {
  createStandaloneIndex,
  browseAndAttachIndex as openSecondaryIndex,
  selectPrimaryIndex,
  saveWorkspaceIndexBinding,
} from './IndexManagementService';
