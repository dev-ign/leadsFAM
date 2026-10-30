export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  public: {
    Tables: {
      contact_emails: {
        Row: {
          contact_id: string;
          normalized: string;
          organization_id: string;
          position: number;
          value: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id: string;
          normalized: string;
          organization_id: string;
          position: number;
          value: string;
        };
        Update: {
          contact_id?: string;
          normalized?: string;
          organization_id?: string;
          position?: number;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'contact_emails_organization_id_contact_id_fkey';
            columns: ['organization_id', 'contact_id'];
            isOneToOne: false;
            referencedRelation: 'contacts';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      contact_phones: {
        Row: {
          contact_id: string;
          normalized: string | null;
          organization_id: string;
          position: number;
          region: string | null;
          value: string;
        };
        ComputedFields: never;
        Insert: {
          contact_id: string;
          normalized?: string | null;
          organization_id: string;
          position: number;
          region?: string | null;
          value: string;
        };
        Update: {
          contact_id?: string;
          normalized?: string | null;
          organization_id?: string;
          position?: number;
          region?: string | null;
          value?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'contact_phones_organization_id_contact_id_fkey';
            columns: ['organization_id', 'contact_id'];
            isOneToOne: false;
            referencedRelation: 'contacts';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      contacts: {
        Row: {
          archived_at: string | null;
          company_name: string;
          created_at: string;
          created_by: string;
          display_name: string;
          first_name: string;
          id: string;
          kind: string;
          last_name: string;
          organization_id: string;
          search_name: string | null;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          company_name?: string;
          created_at?: string;
          created_by: string;
          display_name: string;
          first_name?: string;
          id?: string;
          kind: string;
          last_name?: string;
          organization_id: string;
          search_name?: never;
          updated_at?: string;
          version?: number;
        };
        Update: {
          archived_at?: string | null;
          company_name?: string;
          created_at?: string;
          created_by?: string;
          display_name?: string;
          first_name?: string;
          id?: string;
          kind?: string;
          last_name?: string;
          organization_id?: string;
          search_name?: never;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'contacts_organization_id_created_by_fkey';
            columns: ['organization_id', 'created_by'];
            isOneToOne: false;
            referencedRelation: 'organization_memberships';
            referencedColumns: ['organization_id', 'user_id'];
          },
          {
            foreignKeyName: 'contacts_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      crm_activities: {
        Row: {
          actor_id: string;
          contact_id: string | null;
          created_at: string;
          details: NonNullable<Json>;
          event: string;
          id: string;
          lead_id: string | null;
          organization_id: string;
          reason: string | null;
          request_id: string | null;
        };
        ComputedFields: never;
        Insert: {
          actor_id: string;
          contact_id?: string | null;
          created_at?: string;
          details?: NonNullable<Json>;
          event: string;
          id?: string;
          lead_id?: string | null;
          organization_id: string;
          reason?: string | null;
          request_id?: string | null;
        };
        Update: {
          actor_id?: string;
          contact_id?: string | null;
          created_at?: string;
          details?: NonNullable<Json>;
          event?: string;
          id?: string;
          lead_id?: string | null;
          organization_id?: string;
          reason?: string | null;
          request_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'crm_activities_organization_id_actor_id_fkey';
            columns: ['organization_id', 'actor_id'];
            isOneToOne: false;
            referencedRelation: 'organization_memberships';
            referencedColumns: ['organization_id', 'user_id'];
          },
          {
            foreignKeyName: 'crm_activities_organization_id_contact_id_fkey';
            columns: ['organization_id', 'contact_id'];
            isOneToOne: false;
            referencedRelation: 'contacts';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'crm_activities_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'crm_activities_organization_id_lead_id_fkey';
            columns: ['organization_id', 'lead_id'];
            isOneToOne: false;
            referencedRelation: 'leads';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      lead_attributions: {
        Row: {
          accepted_at: string;
          campaign: string | null;
          channel: string;
          claimed_acquired_at: string | null;
          external_reference: string | null;
          landing_url: string | null;
          lead_id: string;
          organization_id: string;
          provider: string | null;
          source_id: string | null;
          utm_medium: string | null;
          utm_source: string | null;
        };
        ComputedFields: never;
        Insert: {
          accepted_at?: string;
          campaign?: string | null;
          channel: string;
          claimed_acquired_at?: string | null;
          external_reference?: string | null;
          landing_url?: string | null;
          lead_id: string;
          organization_id: string;
          provider?: string | null;
          source_id?: string | null;
          utm_medium?: string | null;
          utm_source?: string | null;
        };
        Update: {
          accepted_at?: string;
          campaign?: string | null;
          channel?: string;
          claimed_acquired_at?: string | null;
          external_reference?: string | null;
          landing_url?: string | null;
          lead_id?: string;
          organization_id?: string;
          provider?: string | null;
          source_id?: string | null;
          utm_medium?: string | null;
          utm_source?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'lead_attributions_organization_id_lead_id_fkey';
            columns: ['organization_id', 'lead_id'];
            isOneToOne: true;
            referencedRelation: 'leads';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'lead_attributions_organization_id_source_id_fkey';
            columns: ['organization_id', 'source_id'];
            isOneToOne: false;
            referencedRelation: 'lead_sources';
            referencedColumns: ['organization_id', 'id'];
          },
        ];
      };
      lead_sources: {
        Row: {
          archived_at: string | null;
          created_at: string;
          created_by: string;
          id: string;
          name: string;
          organization_id: string;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          created_at?: string;
          created_by: string;
          id?: string;
          name: string;
          organization_id: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          archived_at?: string | null;
          created_at?: string;
          created_by?: string;
          id?: string;
          name?: string;
          organization_id?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'lead_sources_organization_id_created_by_fkey';
            columns: ['organization_id', 'created_by'];
            isOneToOne: false;
            referencedRelation: 'organization_memberships';
            referencedColumns: ['organization_id', 'user_id'];
          },
          {
            foreignKeyName: 'lead_sources_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      leads: {
        Row: {
          archived_at: string | null;
          assigned_membership_generation: number | null;
          closed_at: string | null;
          contact_id: string;
          created_at: string;
          created_by: string;
          description: string;
          id: string;
          last_activity_at: string;
          last_assigned_user_id: string | null;
          organization_id: string;
          outcome: string | null;
          priority: string;
          search_title: string | null;
          status: string;
          title: string;
          updated_at: string;
          version: number;
        };
        ComputedFields: never;
        Insert: {
          archived_at?: string | null;
          assigned_membership_generation?: number | null;
          closed_at?: string | null;
          contact_id: string;
          created_at?: string;
          created_by: string;
          description?: string;
          id?: string;
          last_activity_at?: string;
          last_assigned_user_id?: string | null;
          organization_id: string;
          outcome?: string | null;
          priority?: string;
          search_title?: never;
          status?: string;
          title: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          archived_at?: string | null;
          assigned_membership_generation?: number | null;
          closed_at?: string | null;
          contact_id?: string;
          created_at?: string;
          created_by?: string;
          description?: string;
          id?: string;
          last_activity_at?: string;
          last_assigned_user_id?: string | null;
          organization_id?: string;
          outcome?: string | null;
          priority?: string;
          search_title?: never;
          status?: string;
          title?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'leads_organization_id_contact_id_fkey';
            columns: ['organization_id', 'contact_id'];
            isOneToOne: false;
            referencedRelation: 'contacts';
            referencedColumns: ['organization_id', 'id'];
          },
          {
            foreignKeyName: 'leads_organization_id_created_by_fkey';
            columns: ['organization_id', 'created_by'];
            isOneToOne: false;
            referencedRelation: 'organization_memberships';
            referencedColumns: ['organization_id', 'user_id'];
          },
          {
            foreignKeyName: 'leads_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'leads_organization_id_last_assigned_user_id_fkey';
            columns: ['organization_id', 'last_assigned_user_id'];
            isOneToOne: false;
            referencedRelation: 'organization_memberships';
            referencedColumns: ['organization_id', 'user_id'];
          },
        ];
      };
      organization_invitations: {
        Row: {
          accepted_at: string | null;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string;
          organization_id: string;
          revoked_at: string | null;
          role: string;
          token_hash: string;
        };
        ComputedFields: never;
        Insert: {
          accepted_at?: string | null;
          created_at?: string;
          email: string;
          expires_at?: string;
          id?: string;
          invited_by: string;
          organization_id: string;
          revoked_at?: string | null;
          role: string;
          token_hash: string;
        };
        Update: {
          accepted_at?: string | null;
          created_at?: string;
          email?: string;
          expires_at?: string;
          id?: string;
          invited_by?: string;
          organization_id?: string;
          revoked_at?: string | null;
          role?: string;
          token_hash?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'organization_invitations_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'organization_invitations_organization_id_invited_by_fkey';
            columns: ['organization_id', 'invited_by'];
            isOneToOne: false;
            referencedRelation: 'organization_memberships';
            referencedColumns: ['organization_id', 'user_id'];
          },
        ];
      };
      organization_memberships: {
        Row: {
          crm_assignment_generation: number;
          joined_at: string;
          organization_id: string;
          revoked_at: string | null;
          role: string;
          user_id: string;
        };
        ComputedFields: never;
        Insert: {
          crm_assignment_generation?: number;
          joined_at?: string;
          organization_id: string;
          revoked_at?: string | null;
          role: string;
          user_id: string;
        };
        Update: {
          crm_assignment_generation?: number;
          joined_at?: string;
          organization_id?: string;
          revoked_at?: string | null;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'organization_memberships_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'organization_memberships_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      organization_notes: {
        Row: {
          author_id: string;
          body: string;
          created_at: string;
          id: string;
          organization_id: string;
          title: string;
          updated_at: string;
        };
        ComputedFields: never;
        Insert: {
          author_id: string;
          body?: string;
          created_at?: string;
          id?: string;
          organization_id: string;
          title: string;
          updated_at?: string;
        };
        Update: {
          author_id?: string;
          body?: string;
          created_at?: string;
          id?: string;
          organization_id?: string;
          title?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'organization_notes_organization_id_author_id_fkey';
            columns: ['organization_id', 'author_id'];
            isOneToOne: false;
            referencedRelation: 'organization_memberships';
            referencedColumns: ['organization_id', 'user_id'];
          },
          {
            foreignKeyName: 'organization_notes_organization_id_fkey';
            columns: ['organization_id'];
            isOneToOne: false;
            referencedRelation: 'organizations';
            referencedColumns: ['id'];
          },
        ];
      };
      organizations: {
        Row: {
          created_at: string;
          id: string;
          name: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      profiles: {
        Row: {
          created_at: string;
          display_name: string;
          id: string;
        };
        ComputedFields: never;
        Insert: {
          created_at?: string;
          display_name?: string;
          id: string;
        };
        Update: {
          created_at?: string;
          display_name?: string;
          id?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      accept_invitation: { Args: { p_hash: string }; Returns: Json };
      change_member: {
        Args: { p_org: string; p_remove?: boolean; p_role?: string; p_user: string };
        Returns: Json;
      };
      create_invitation: {
        Args: { p_email: string; p_hash: string; p_org: string; p_role: string };
        Returns: Json;
      };
      create_organization: { Args: { p_name: string }; Returns: Json };
      crm_activity: {
        Args: { p_after?: Json; p_id: string; p_kind: string; p_org: string; p_size?: number };
        Returns: Json;
      };
      crm_candidates: { Args: { p_data: Json; p_org: string }; Returns: Json };
      crm_change_lead: {
        Args: { p_action: string; p_data: Json; p_id: string; p_org: string; p_version: number };
        Returns: Json;
      };
      crm_get: { Args: { p_id: string; p_kind: string; p_org: string }; Returns: Json };
      crm_import_execute: {
        Args: { p_attempt: string; p_job: string; p_org: string; p_rows: Json };
        Returns: Json;
      };
      crm_import_status: {
        Args: { p_attempt?: string; p_job?: string; p_org: string };
        Returns: Json;
      };
      crm_intake_manual: { Args: { p_data: Json; p_key: string; p_org: string }; Returns: Json };
      crm_preview_candidates: { Args: { p_inputs: Json; p_org: string }; Returns: Json };
      crm_query: {
        Args: { p_after?: Json; p_kind: string; p_org: string; p_query: Json };
        Returns: Json;
      };
      crm_save_contact: {
        Args: {
          p_action: string;
          p_data: Json;
          p_id?: string;
          p_key?: string;
          p_org: string;
          p_version?: number;
        };
        Returns: Json;
      };
      crm_sources: {
        Args: { p_data?: Json; p_id?: string; p_org: string; p_version?: number };
        Returns: Json;
      };
      delete_note: { Args: { p_id: string; p_org: string }; Returns: Json };
      get_organization: { Args: { p_org: string }; Returns: Json };
      list_invitations: { Args: { p_org: string }; Returns: Json };
      list_members: { Args: { p_org: string }; Returns: Json };
      list_notes: { Args: { p_org: string }; Returns: Json };
      list_organizations: { Args: Record<PropertyKey, never>; Returns: Json };
      revoke_invitation: { Args: { p_id: string; p_org: string }; Returns: Json };
      update_organization: { Args: { p_name: string; p_org: string }; Returns: Json };
      write_note: {
        Args: { p_body: string; p_id?: string; p_org: string; p_title: string };
        Returns: Json;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
