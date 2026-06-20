export default interface BaseData {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export const serializeNestedBaseObject = (obj: any): any => {
  if (obj instanceof Array) {
    return obj.map((o) => serializeNestedBaseObject(o));
  } else if (obj instanceof Object) {
    const newObj: any = {};

    Object.keys(obj).forEach((key) => {
      if (obj[key] instanceof Object || obj[key] instanceof Array) {
        newObj[key] = serializeNestedBaseObject(obj[key]);
        return;
      }

      // Check if its an isoformat date
      if (
        typeof obj[key] === "string" &&
        obj[key].match(
          /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|([+-]\d{2}:\d{2}))?/
        )
      ) {
        newObj[key] = new Date(obj[key]);
        return;
      }

      newObj[key] = obj[key];
    });

    if (obj.external_id) {
      newObj.id = obj.external_id;
    }

    return newObj;
  } else {
    return Object.assign({}, obj);
  }
};
