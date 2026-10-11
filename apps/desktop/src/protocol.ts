// Wire contract mirrors crates/protocol. Generate bindings before extending the API substantially.
export interface Community { id: string; name: string; initials: string }
export interface Channel { id: string; community_id: string; name: string; kind: 'text' | 'voice'; description: string }
export interface Member { id: string; name: string; initials: string; color: string; status: string }
export interface Message { id: string; channel_id: string; author_id: string; content: string; created_at_ms: number }
export interface Snapshot {
  communities: Community[];
  channels: Channel[];
  members: Member[];
  messages: Message[];
  selected_channel_id: string;
  current_user_id: string;
}
