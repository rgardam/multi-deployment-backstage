import {
  CellText,
  type ColumnConfig,
  Table,
  Text,
  useTable,
} from '@backstage/ui';
import type { Notice } from '../../api';

const columns: ColumnConfig<Notice>[] = [
  {
    id: 'title',
    label: 'Title',
    isRowHeader: true,
    cell: notice => <CellText title={notice.title} />,
  },
  {
    id: 'body',
    label: 'Notice',
    cell: notice => <CellText title={notice.body} />,
  },
  {
    id: 'author',
    label: 'Posted by',
    cell: notice => <CellText title={notice.author} />,
  },
  {
    id: 'createdAt',
    label: 'Posted',
    cell: notice => (
      <CellText title={new Date(notice.createdAt).toLocaleString()} />
    ),
  },
];

export const NoticeList = ({ notices }: { notices: Notice[] }) => {
  const { tableProps } = useTable({
    mode: 'complete',
    data: notices,
    paginationOptions: { pageSize: notices.length || 1 },
  });

  if (!notices.length) {
    return <Text color="secondary">No notices yet. Post the first one.</Text>;
  }
  return (
    <Table
      columnConfig={columns}
      {...tableProps}
      pagination={{ type: 'none' }}
    />
  );
};
