import { registerChannelSlots } from '../shell/slots';
import { ChannelSearchBox } from './ChannelSearchBox';
import { SearchResultsPanel } from './SearchResultsPanel';
import { useSearchPanelOpen } from './store';

// The shell renders these in the channel header and the channel body (see src/shell/slots.ts); main.tsx imports this module once.
registerChannelSlots({ HeaderSearch: ChannelSearchBox, RightPanel: SearchResultsPanel, useRightPanelOpen: useSearchPanelOpen });

export { ChannelSearchBox, SearchResultsPanel, useSearchPanelOpen };
