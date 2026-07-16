from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from jsonschema import FormatChecker
from jsonschema.exceptions import ValidationError
from jsonschema.validators import validator_for
from referencing import Registry, Resource


def _repository_root() -> Path:
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "specs" / "akep" / "v0.1" / "schemas").is_dir():
            return candidate
    raise RuntimeError("could not locate the repository contract root")


@dataclass(frozen=True)
class ContractSet:
    repository_root: Path
    protocol_schemas: dict[str, dict[str, Any]]
    internal_schemas: dict[str, dict[str, Any]]
    registry: Registry

    @classmethod
    def load(cls) -> ContractSet:
        root = _repository_root()
        protocol_schemas = _read_schema_directory(root / "specs" / "akep" / "v0.1" / "schemas")
        internal_schemas = _read_schema_directory(root / "contracts" / "internal")
        resources: list[tuple[str, Resource[Any]]] = []
        for schema in (*protocol_schemas.values(), *internal_schemas.values()):
            resources.append((schema["$id"], Resource.from_contents(schema)))
        return cls(root, protocol_schemas, internal_schemas, Registry().with_resources(resources))

    def validate(self, schema_id: str, instance: object) -> list[ValidationError]:
        schema = self._schema(schema_id)
        validator_type = validator_for(schema)
        validator_type.check_schema(schema)
        validator = validator_type(schema, registry=self.registry, format_checker=FormatChecker())
        return sorted(validator.iter_errors(instance), key=lambda error: list(error.absolute_path))

    def _schema(self, schema_id: str) -> dict[str, Any]:
        for schemas in (self.protocol_schemas, self.internal_schemas):
            if schema_id in schemas:
                return schemas[schema_id]
        raise KeyError(f"unknown schema: {schema_id}")


def _read_schema_directory(directory: Path) -> dict[str, dict[str, Any]]:
    schemas: dict[str, dict[str, Any]] = {}
    for path in sorted(directory.glob("*.json")):
        schema = json.loads(path.read_text(encoding="utf-8"))
        schemas[schema["$id"]] = schema
    return schemas
