export interface SchemaFieldConfig {
  type: string;
  description?: string;
  required?: boolean;
  fields?: Record<string, SchemaFieldConfig>;
}

export class SchemaField {
  public type: string;
  public description?: string;
  public required?: boolean;
  public fields?: Schema;

  constructor(config: SchemaFieldConfig) {
    this.type = config.type;
    this.description = config.description;
    this.required = config.required;

    if (config.fields) {
      this.fields = new Schema({ fields: config.fields });
    }
  }

  toDict(): any {
    const result: any = {
      type: this.type,
    };

    if (this.description) {
      result.description = this.description;
    }

    if (this.required !== undefined) {
      result.required = this.required;
    }

    if (this.fields) {
      result.fields = this.fields.toDict();
    }

    return result;
  }
}

export interface SchemaConfig {
  fields: Record<string, SchemaFieldConfig>;
}

export class Schema {
  public fields: Record<string, SchemaField>;

  constructor(config: SchemaConfig) {
    this.fields = {};

    Object.entries(config.fields).forEach(([key, fieldConfig]) => {
      this.fields[key] = new SchemaField(fieldConfig);
    });
  }

  toDict(): any {
    const result: any = {
      fields: {},
    };

    Object.entries(this.fields).forEach(([key, field]) => {
      result.fields[key] = field.toDict();
    });

    return result;
  }
}
