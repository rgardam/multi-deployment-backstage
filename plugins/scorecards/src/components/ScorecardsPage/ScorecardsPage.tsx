import { useMemo } from 'react';
import { Progress, ResponseErrorPanel } from '@backstage/core-components';
import { fetchApiRef, useApi } from '@backstage/frontend-plugin-api';
import {
  type ScorecardSummary,
  scorecardChecks,
} from '@internal/backstage-plugin-scorecards-common';
import {
  CellText,
  type ColumnConfig,
  Container,
  Flex,
  Header,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import useAsync from 'react-use/esm/useAsync';
import { getSummary } from '../../api';

type CheckRow = ScorecardSummary['checks'][number];
type NamespaceRow = ScorecardSummary['namespaces'][number] & { id: string };

const checkColumns: ColumnConfig<CheckRow>[] = [
  {
    id: 'title',
    label: 'Check',
    isRowHeader: true,
    cell: row => <CellText title={row.title} />,
  },
  {
    id: 'description',
    label: 'What it looks for',
    cell: row => <CellText title={row.description} />,
  },
  {
    id: 'passRate',
    label: 'Passing',
    cell: row => <CellText title={`${row.passRate}%`} />,
  },
];

const namespaceColumns: ColumnConfig<NamespaceRow>[] = [
  {
    id: 'namespace',
    label: 'Namespace',
    isRowHeader: true,
    cell: row => <CellText title={row.namespace} />,
  },
  {
    id: 'entities',
    label: 'Components',
    cell: row => <CellText title={String(row.entities)} />,
  },
  {
    id: 'averageScore',
    label: 'Average score',
    cell: row => <CellText title={`${row.averageScore}%`} />,
  },
];

function SimpleTable<T extends { id: string }>(props: {
  rows: T[];
  columns: ColumnConfig<T>[];
}) {
  const { tableProps } = useTable({
    mode: 'complete',
    data: props.rows,
    paginationOptions: { pageSize: props.rows.length || 1 },
  });
  return (
    <Table
      columnConfig={props.columns}
      {...tableProps}
      pagination={{ type: 'none' }}
    />
  );
}

export const ScorecardsPage = () => {
  const fetchApi = useApi(fetchApiRef);
  const { value, loading, error } = useAsync(
    () => getSummary(fetchApi, 'component'),
    [fetchApi],
  );
  // Which checks exist and how they are described comes from the shared
  // package; the backend supplies the numbers. Row ids are prefixed because a
  // table's rows and columns share one key space: a check called
  // "description" would otherwise collide with the description column.
  const checkRows = useMemo(
    () =>
      scorecardChecks.map(check => ({
        ...check,
        id: `check:${check.id}`,
        passRate: value?.checks.find(c => c.id === check.id)?.passRate ?? 0,
      })),
    [value],
  );
  const namespaceRows = useMemo(
    () =>
      (value?.namespaces ?? []).map(ns => ({
        ...ns,
        id: `namespace:${ns.namespace}`,
      })),
    [value],
  );

  return (
    <>
      <Header
        title="Scorecards"
        description="Every component in the catalog, scored by the backend-scorecards deployment"
      />
      <Container>
        {loading && <Progress />}
        {error && <ResponseErrorPanel error={error} />}
        {value && (
          <Flex direction="column" gap="4">
            <Text variant="title-small">
              {`${value.entities} components, average score ${value.averageScore}%`}
            </Text>
            <SimpleTable rows={checkRows} columns={checkColumns} />
            <Text variant="title-x-small">By namespace</Text>
            <SimpleTable rows={namespaceRows} columns={namespaceColumns} />
          </Flex>
        )}
      </Container>
    </>
  );
};
