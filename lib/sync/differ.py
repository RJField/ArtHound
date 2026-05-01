def find_changes(
    incoming: list[dict],
    existing_hashes: dict[str, str],
) -> tuple[list[dict], int]:
    """
    Compare incoming normalised records against existing source_hash values.
    Returns (records_to_upsert, unchanged_count).
    Used for full syncs to avoid unnecessary writes.
    """
    to_upsert = []
    unchanged = 0

    for record in incoming:
        source_id = record["source_record_id"]
        if existing_hashes.get(source_id) != record.get("source_hash"):
            to_upsert.append(record)
        else:
            unchanged += 1

    return to_upsert, unchanged
